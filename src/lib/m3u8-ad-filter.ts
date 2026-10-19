/**
 * M3U8 分片广告过滤（客户端 hls.js Loader）
 *
 * 从播放页抽出的纯函数 + Loader 工厂，播放页只负责挂载，算法在此文件内独立迭代。
 *
 * 提供两档过滤：
 * - legacy：仅移除 #EXT-X-DISCONTINUITY 标记行（与线上历史行为一致，最保守）。
 * - smart（默认）：参考 dongguaTV 的分组判定——以 #EXT-X-DISCONTINUITY 为界把
 *   播放列表切成若干分组，"总时长 3~120s 且分片数 < 15" 的分组判为广告组整组移除，
 *   并带 20% 保险丝：待删内容占比过高时整体回退到 legacy 行为，
 *   宁可放过广告，不可误删正片。
 *
 * 两者都只处理媒体播放列表（media playlist）；主播放列表（含 #EXT-X-STREAM-INF）
 * 原样返回，避免破坏多码率切换。
 */

/** 过滤模式：legacy=仅去标记行；smart=分组剔除广告分段 */
export type AdFilterMode = 'legacy' | 'smart';

export interface SmartFilterOptions {
  /** 广告组时长下界（秒），默认 3 */
  minAdDuration?: number;
  /** 广告组时长上界（秒），默认 120 */
  maxAdDuration?: number;
  /** 广告组分片数上界（< 该值才可能是广告组），默认 15 */
  maxAdSegments?: number;
  /**
   * 保险丝：待删分片数占总分片数的比例上限，超过则放弃 smart 回退 legacy。
   * 默认 0.2（20%）——与 dongguaTV 一致，宁可有广告不可没画面。
   */
  maxRemovedRatio?: number;
}

export interface M3U8FilterStats {
  /** 原始行数 */
  totalLines: number;
  /** 被移除的行数 */
  removedLines: number;
}

export interface SmartFilterStats extends M3U8FilterStats {
  /** 判定为广告并移除的分组数 */
  removedBlocks: number;
  /** 被移除的分片数 */
  removedSegments: number;
  /** 被移除分片的预估总时长（秒） */
  removedDuration: number;
  /** 是否触发保险丝回退（true 表示本次未按 smart 删除） */
  fallback: boolean;
}

/**
 * 过滤 m3u8 中的广告标记行（legacy 实现：仅删除 #EXT-X-DISCONTINUITY 行）
 */
export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';

  // 按行分割M3U8内容
  const lines = m3u8Content.split('\n');
  const filteredLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 只过滤#EXT-X-DISCONTINUITY标识
    if (!line.includes('#EXT-X-DISCONTINUITY')) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

/**
 * 带统计信息的 legacy 过滤（供 UI 展示"已过滤 X 个广告"与调试使用）
 */
export function filterAdsFromM3U8WithStats(m3u8Content: string): {
  content: string;
  stats: M3U8FilterStats;
} {
  if (!m3u8Content) {
    return { content: '', stats: { totalLines: 0, removedLines: 0 } };
  }

  const lines = m3u8Content.split('\n');
  const filteredLines = lines.filter(
    (line) => !line.includes('#EXT-X-DISCONTINUITY')
  );

  return {
    content: filteredLines.join('\n'),
    stats: {
      totalLines: lines.length,
      removedLines: lines.length - filteredLines.length,
    },
  };
}

interface ParsedLine {
  /** 原始行（已去掉 \r） */
  raw: string;
  /** 所属分组下标（以 #EXT-X-DISCONTINUITY 为界，从头累加） */
  block: number;
  /** 该行是否是一条分片 URI（非空、非 # 开头） */
  isSegment: boolean;
  /** 该行的 #EXTINF 时长（秒），非 EXTINF 行为 undefined */
  duration?: number;
  /** 该行是否是 #EXT-X-DISCONTINUITY 标记 */
  isDiscontinuity: boolean;
}

function parsePlaylist(content: string): ParsedLine[] {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const parsed: ParsedLine[] = [];
  let block = 0;
  let pendingDuration: number | undefined;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed.includes('#EXT-X-DISCONTINUITY')) {
      // 遇到不连续标记：开启新分组。第一个 DISCONTINUITY 之前的行归入 block 0。
      if (parsed.some((p) => p.block === block)) {
        block += 1;
      }
      parsed.push({
        raw,
        block,
        isSegment: false,
        isDiscontinuity: true,
      });
      pendingDuration = undefined;
      continue;
    }

    const extinfMatch = trimmed.match(/^#EXTINF:\s*([\d.]+)/);
    if (extinfMatch) {
      pendingDuration = Number(extinfMatch[1]);
      parsed.push({
        raw,
        block,
        isSegment: false,
        duration: pendingDuration,
        isDiscontinuity: false,
      });
      continue;
    }

    const isSegment = trimmed.length > 0 && !trimmed.startsWith('#');
    parsed.push({
      raw,
      block,
      isSegment,
      // 分片 URI 行继承前面最近的 #EXTINF 时长，使分组时长统计准确
      duration: isSegment ? pendingDuration : undefined,
      isDiscontinuity: false,
    });

    if (isSegment) {
      pendingDuration = undefined;
    }
  }

  return parsed;
}

/** 主播放列表（多码率）不做分组过滤，原样返回 */
function isMasterPlaylist(content: string): boolean {
  return /#EXT-X-STREAM-INF/.test(content);
}

interface BlockInfo {
  index: number;
  segments: number;
  duration: number;
}

function collectBlocks(parsed: ParsedLine[]): BlockInfo[] {
  const map = new Map<number, BlockInfo>();
  for (const line of parsed) {
    if (!line.isSegment) continue;
    let info = map.get(line.block);
    if (!info) {
      info = { index: line.block, segments: 0, duration: 0 };
      map.set(line.block, info);
    }
    info.segments += 1;
    info.duration += line.duration ?? 0;
  }
  return Array.from(map.values()).sort((a, b) => a.index - b.index);
}

/**
 * 智能分组过滤（参考 dongguaTV 判定规则 + 20% 保险丝）。
 *
 * 判定为广告分组需同时满足：
 * 1. 分片数 < maxAdSegments（默认 15）；
 * 2. 总时长落在 [minAdDuration, maxAdDuration]（默认 3~120 秒）。
 *
 * 保险丝：若待删分片数 / 总分片数 > maxRemovedRatio（默认 20%），
 * 或待删时长 / 总时长 > maxRemovedRatio，则放弃删除、回退 legacy 行为。
 */
export function filterAdsFromM3U8Smart(
  m3u8Content: string,
  options: SmartFilterOptions = {}
): string {
  return filterAdsFromM3U8SmartWithStats(m3u8Content, options).content;
}

export function filterAdsFromM3U8SmartWithStats(
  m3u8Content: string,
  options: SmartFilterOptions = {}
): { content: string; stats: SmartFilterStats } {
  const {
    minAdDuration = 3,
    maxAdDuration = 120,
    maxAdSegments = 15,
    maxRemovedRatio = 0.2,
  } = options;

  if (!m3u8Content) {
    return {
      content: '',
      stats: {
        totalLines: 0,
        removedLines: 0,
        removedBlocks: 0,
        removedSegments: 0,
        removedDuration: 0,
        fallback: false,
      },
    };
  }

  // 主播放列表（多码率）与无 DISCONTINUITY 的列表：没有分组边界可切，
  // 主播放列表原样返回，其余走 legacy（通常也是无操作）
  if (isMasterPlaylist(m3u8Content)) {
    return {
      content: m3u8Content,
      stats: {
        totalLines: m3u8Content.split('\n').length,
        removedLines: 0,
        removedBlocks: 0,
        removedSegments: 0,
        removedDuration: 0,
        fallback: true,
      },
    };
  }

  if (!m3u8Content.includes('#EXT-X-DISCONTINUITY')) {
    const legacy = filterAdsFromM3U8WithStats(m3u8Content);
    return {
      content: legacy.content,
      stats: {
        ...legacy.stats,
        removedBlocks: 0,
        removedSegments: 0,
        removedDuration: 0,
        fallback: true,
      },
    };
  }

  const parsed = parsePlaylist(m3u8Content);
  const blocks = collectBlocks(parsed);
  const totalSegments = blocks.reduce((sum, b) => sum + b.segments, 0);
  const totalDuration = blocks.reduce((sum, b) => sum + b.duration, 0);

  const adBlocks = blocks
    .filter(
      (b) =>
        b.segments > 0 &&
        b.segments < maxAdSegments &&
        b.duration >= minAdDuration &&
        b.duration <= maxAdDuration
    )
    .map((b) => b.index);

  const removedSegments = blocks
    .filter((b) => adBlocks.includes(b.index))
    .reduce((sum, b) => sum + b.segments, 0);
  const removedDuration = blocks
    .filter((b) => adBlocks.includes(b.index))
    .reduce((sum, b) => sum + b.duration, 0);

  const ratioLimit = Math.max(maxRemovedRatio, 0);
  const segmentRatio = totalSegments > 0 ? removedSegments / totalSegments : 0;
  const durationRatio = totalDuration > 0 ? removedDuration / totalDuration : 0;

  // 保险丝：删得太多就整体回退，宁可有广告不可没画面
  if (
    adBlocks.length === 0 ||
    segmentRatio > ratioLimit ||
    durationRatio > ratioLimit
  ) {
    const legacy = filterAdsFromM3U8WithStats(m3u8Content);
    return {
      content: legacy.content,
      stats: {
        ...legacy.stats,
        removedBlocks: 0,
        removedSegments: 0,
        removedDuration: 0,
        fallback: true,
      },
    };
  }

  // 重建播放列表：丢掉广告分组的分片行；同时丢掉被删分组边界上的
  // #EXT-X-DISCONTINUITY 标记，避免出现连续两个标记或尾部孤立标记。
  const droppedLines = new Set<ParsedLine>();
  for (const line of parsed) {
    if (adBlocks.includes(line.block) && (line.isSegment || line.duration !== undefined)) {
      droppedLines.add(line);
    }
  }

  // 找到每个"被删分组"前后的 DISCONTINUITY 行，删掉紧邻其前的那条：
  // 这样正片分组之间仍保留恰好一个 DISCONTINUITY。
  const discontinuityIdxByBlock = new Map<number, number[]>();
  parsed.forEach((line, idx) => {
    if (!line.isDiscontinuity) return;
    const arr = discontinuityIdxByBlock.get(line.block) || [];
    arr.push(idx);
    discontinuityIdxByBlock.set(line.block, arr);
  });

  for (const blockIndex of adBlocks) {
    const markers = discontinuityIdxByBlock.get(blockIndex) || [];
    // 该分组自身前缀的标记（开启本分组的那条）优先删除
    const own = markers[0];
    if (own !== undefined) {
      droppedLines.add(parsed[own]);
      continue;
    }
    // 兜底：删除后一个分组的前缀标记
    const nextMarkers = discontinuityIdxByBlock.get(blockIndex + 1) || [];
    if (nextMarkers[0] !== undefined) {
      droppedLines.add(parsed[nextMarkers[0]]);
    }
  }

  const keptLines = parsed.filter((line) => !droppedLines.has(line));

  return {
    content: keptLines.map((l) => l.raw).join('\n'),
    stats: {
      totalLines: parsed.length,
      removedLines: parsed.length - keptLines.length,
      removedBlocks: adBlocks.length,
      removedSegments,
      removedDuration: Math.round(removedDuration * 100) / 100,
      fallback: false,
    },
  };
}

type HlsLoaderContext = { type?: string };
type HlsLoaderCallbacks = {
  // hls.js 的 LoaderCallbacks.onSuccess 实际签名为四参（第四个为网络详情）
  onSuccess: (
    response: any,
    stats: any,
    context: any,
    networkDetails: any
  ) => any;
};

export interface AdFilterLoaderOptions {
  /** 过滤模式，默认 smart */
  mode?: AdFilterMode;
  /** 每次过滤完成的统计回调（用于调试与"已过滤 X 个广告"展示） */
  onStats?: (stats: SmartFilterStats | M3U8FilterStats) => void;
  /** smart 模式的可调参数 */
  smartOptions?: SmartFilterOptions;
}

/**
 * 创建带广告过滤的 hls.js Loader 类。
 *
 * 与具体 Hls 构造器解耦（通过参数传入），便于单测与 hls.js 升级。
 * 只拦截 manifest / level 两类请求（播放列表文本），
 * fragment（.ts 分片）等二进制请求不受影响。
 *
 * @param Hls hls.js 构造器（用于取 Hls.DefaultConfig.loader 作为基类）
 */
export function createAdFilterHlsLoader(
  Hls: any,
  options: AdFilterLoaderOptions = {}
): any {
  const DefaultLoader = Hls.DefaultConfig.loader;
  const mode: AdFilterMode = options.mode || 'smart';

  return class CustomHlsJsLoader extends DefaultLoader {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (
        context: HlsLoaderContext,
        config: any,
        callbacks: HlsLoaderCallbacks
      ) {
        // 拦截manifest和level请求
        if (context.type === 'manifest' || context.type === 'level') {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (
            response: any,
            stats: any,
            context: any
          ) {
            // 如果是m3u8文件，处理内容以移除广告分段
            if (response.data && typeof response.data === 'string') {
              if (mode === 'legacy') {
                response.data = filterAdsFromM3U8(response.data);
              } else {
                const result = filterAdsFromM3U8SmartWithStats(
                  response.data,
                  options.smartOptions
                );
                response.data = result.content;
                options.onStats?.(result.stats);
              }
            }
            return onSuccess(response, stats, context, null);
          };
        }
        // 执行原始load方法
        load(context, config, callbacks);
      };
    }
  };
}
