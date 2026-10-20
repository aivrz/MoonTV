/**
 * M3U8 分片广告过滤（客户端 hls.js Loader + 可复用于 Cloudflare Worker 边缘）
 *
 * 从播放页抽出的纯函数 + Loader 工厂，播放页只负责挂载，算法在此文件内独立迭代。
 * 同一份判定逻辑既可在客户端 hls.js Loader 中运行（直连源兜底），
 * 也可在 Cloudflare Worker 中复用（m3u8 出口处改写，客户端根本不拉广告分片）。
 *
 * 提供两档过滤：
 * - legacy：仅移除 #EXT-X-DISCONTINUITY 标记行（与线上历史行为一致，最保守）。
 * - smart（默认）：参考 dongguaTV 的分组判定 + 标准广告标记 + 域名/时长启发式。
 *
 * smart 的判定（任一命中即视为广告并整组/整段移除）：
 *   1) 以 #EXT-X-DISCONTINUITY 为界切分组，"总时长 3~120s 且分片数 < 15" 判为广告组；
 *   2) #EXT-X-CUE-OUT … #EXT-X-CUE-IN 之间的分片（HLS 标准广告标记）；
 *   3) #EXT-X-GAP 标记的分片（缺失/广告槽位）；
 *   4) 异域且挂在可疑 TLD（.vip/.bet/.top/.xyz…）下的分片；
 *   5) 时长 < 0.5s 且非媒体扩展名的追踪分片。
 * 并带 20% 保险丝：待删内容占比过高时整体回退 legacy，宁可放过广告，不可误删正片。
 *
 * 两者都只处理媒体播放列表（media playlist）；主播放列表（含 #EXT-X-STREAM-INF）
 * 原样返回，避免破坏多码率切换。
 */

/** 已知广告/可疑 TLD（仅用于"异域 + 可疑 TLD"启发式，命中才删） */
const SUSPICIOUS_TLDS = new Set([
  'vip', 'bet', 'top', 'xyz', 'click', 'link', 'shop', 'club', 'party',
  'date', 'loan', 'racing', 'download', 'country', 'stream', 'win', 'bid',
  'gq', 'cf', 'ga', 'ml', 'tk', 'pw', 'cc', 'tv', 'live',
]);

/** 视为"正常媒体分片"的扩展名，用于排除追踪像素 */
const MEDIA_EXTS = new Set(['ts', 'm4s', 'mp4', 'aac', 'm4a', 'webm', 'key', 'm3u8']);

/** 过滤模式：legacy=仅去标记行；smart=分组 + 标准标记 + 域名/时长启发式 */
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
  /** 是否启用"异域 + 可疑 TLD"分片剔除，默认 true */
  enableSuspiciousDomain?: boolean;
  /** 是否启用 #EXT-X-CUE-OUT/IN、#EXT-X-GAP 等标准广告标记检测，默认 true */
  enableExplicitMarkers?: boolean;
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

  const lines = m3u8Content.split('\n');
  const filteredLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
  /** 该行是否是 #EXT-X-CUE-OUT 标记 */
  isCueOut: boolean;
  /** 该行是否是 #EXT-X-CUE-IN 标记 */
  isCueIn: boolean;
  /** 该行是否是任意 #EXT-X-CUE* 标记（含 CUE-OUT/IN/时长形式），用于清理 */
  isCue: boolean;
  /** 该行是否是 #EXT-X-GAP 标记 */
  isGap: boolean;
  /** 若为分片 URI，其绝对/相对 URL */
  segmentUrl?: string;
  /** 分片主机名（仅当为绝对 URL 时存在） */
  segmentHost?: string;
  /** 分片扩展名（小写，不含点） */
  segmentExt?: string;
}

function parsePlaylist(content: string): ParsedLine[] {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const parsed: ParsedLine[] = [];
  let block = 0;
  let pendingDuration: number | undefined;
  let pendingSegmentUrl: string | undefined;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed.includes('#EXT-X-DISCONTINUITY')) {
      if (parsed.some((p) => p.block === block)) {
        block += 1;
      }
      parsed.push({
        raw,
        block,
        isSegment: false,
        isDiscontinuity: true,
        isCueOut: false,
        isCueIn: false,
        isCue: false,
        isGap: false,
      });
      pendingDuration = undefined;
      pendingSegmentUrl = undefined;
      continue;
    }

    const isCue =
      trimmed.startsWith('#EXT-X-CUE-OUT') ||
      trimmed.startsWith('#EXT-X-CUE-IN') ||
      trimmed.startsWith('#EXT-X-CUE:');
    const isCueOut = trimmed.startsWith('#EXT-X-CUE-OUT');
    const isCueIn = trimmed.startsWith('#EXT-X-CUE-IN');
    const isGap = trimmed.startsWith('#EXT-X-GAP');

    if (isCue || isGap) {
      parsed.push({
        raw,
        block,
        isSegment: false,
        isDiscontinuity: false,
        isCueOut,
        isCueIn,
        isCue,
        isGap,
      });
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
        isCueOut: false,
        isCueIn: false,
        isCue: false,
        isGap: false,
      });
      continue;
    }

    const isSegment = trimmed.length > 0 && !trimmed.startsWith('#');
    let segmentHost: string | undefined;
    let segmentExt: string | undefined;
    if (isSegment) {
      pendingSegmentUrl = trimmed;
      try {
        if (/^https?:\/\//i.test(trimmed)) {
          const u = new URL(trimmed);
          segmentHost = u.hostname.toLowerCase();
          const last = u.pathname.split('/').pop() || '';
          const dot = last.lastIndexOf('.');
          if (dot >= 0) segmentExt = last.slice(dot + 1).toLowerCase();
        }
      } catch {
        // ignore
      }
    }

    parsed.push({
      raw,
      block,
      isSegment,
      duration: isSegment ? pendingDuration : undefined,
      isDiscontinuity: false,
      isCueOut: false,
      isCueIn: false,
      isCue: false,
      isGap: false,
      segmentUrl: isSegment ? pendingSegmentUrl : undefined,
      segmentHost,
      segmentExt,
    });

    if (isSegment) {
      pendingDuration = undefined;
      pendingSegmentUrl = undefined;
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

/** 取出现次数最多的分片主机名，作为"正片"基准域名 */
function mostCommonHost(parsed: ParsedLine[]): string {
  const counter = new Map<string, number>();
  for (const line of parsed) {
    if (line.isSegment && line.segmentHost) {
      counter.set(line.segmentHost, (counter.get(line.segmentHost) || 0) + 1);
    }
  }
  let best = '';
  let bestN = 0;
  counter.forEach((n, host) => {
    if (n > bestN) {
      best = host;
      bestN = n;
    }
  });
  return best;
}

function tldOf(host: string): string {
  const parts = host.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * 计算需要删除的 ParsedLine 下标集合（分片行及其前导 #EXTINF 一并删除）。
 * 返回的每个下标都会从播放列表中剔除。
 */
function buildDropSet(
  parsed: ParsedLine[],
  blocks: BlockInfo[],
  opts: Required<
    Pick<
      SmartFilterOptions,
      'minAdDuration' | 'maxAdDuration' | 'maxAdSegments' | 'enableSuspiciousDomain' | 'enableExplicitMarkers'
    >
  >
): {
  drop: Set<number>;
  removedSegments: number;
  removedDuration: number;
  removedBlocks: number;
  adBlockIndices: number[];
} {
  const drop = new Set<number>();

  const markSegment = (idx: number) => {
    const line = parsed[idx];
    if (!line || !line.isSegment) return;
    drop.add(idx);
    // 前导 #EXTINF
    const prev = parsed[idx - 1];
    if (prev && prev.duration !== undefined) drop.add(idx - 1);
  };

  // 1) DISCONTINUITY 分组启发式（单组清单不处理，避免误删正片）
  const adBlocks = new Set<number>();
  if (blocks.length > 1) {
    for (const b of blocks) {
      if (
        b.segments > 0 &&
        b.segments < opts.maxAdSegments &&
        b.duration >= opts.minAdDuration &&
        b.duration <= opts.maxAdDuration
      ) {
        adBlocks.add(b.index);
      }
    }
  }
  adBlocks.forEach((blockIndex) => {
    parsed.forEach((line, idx) => {
      if (line.block === blockIndex && line.isSegment) markSegment(idx);
    });
  });

  // 2) + 3) 标准广告标记：CUE-OUT..CUE-IN 区间、GAP、以及清理 #EXT-X-CUE* 标记行
  if (opts.enableExplicitMarkers) {
    let inCue = false;
    for (let i = 0; i < parsed.length; i++) {
      const line = parsed[i];
      if (line.isCueOut) {
        inCue = true;
        drop.add(i);
        continue;
      }
      if (line.isCueIn) {
        inCue = false;
        drop.add(i);
        continue;
      }
      if (line.isCue) {
        // 形如 #EXT-X-CUE:<duration> 的时长形式：标记其后一个分片
        drop.add(i);
        if (parsed[i + 1]?.isSegment) markSegment(i + 1);
        continue;
      }
      if (line.isGap) {
        drop.add(i);
        if (parsed[i + 1]?.isSegment) markSegment(i + 1);
        continue;
      }
      if (inCue && line.isSegment) {
        markSegment(i);
      }
    }
  }

  // 4) 异域 + 可疑 TLD 分片
  if (opts.enableSuspiciousDomain) {
    const baseHost = mostCommonHost(parsed);
    for (let i = 0; i < parsed.length; i++) {
      const line = parsed[i];
      if (line.isSegment && line.segmentHost && baseHost) {
        const sameHost = line.segmentHost === baseHost;
        const sameRegistrable =
          line.segmentHost.endsWith('.' + baseHost) || baseHost.endsWith('.' + line.segmentHost);
        if (!sameHost && !sameRegistrable && SUSPICIOUS_TLDS.has(tldOf(line.segmentHost))) {
          markSegment(i);
        }
      }
    }
  }

  // 5) 时长 < 0.5s 且非媒体扩展名的追踪分片
  for (let i = 0; i < parsed.length; i++) {
    const line = parsed[i];
    if (
      line.isSegment &&
      line.duration !== undefined &&
      line.duration < 0.5 &&
      line.segmentExt &&
      !MEDIA_EXTS.has(line.segmentExt)
    ) {
      markSegment(i);
    }
  }

  let removedSegments = 0;
  let removedDuration = 0;
  drop.forEach((idx) => {
    const line = parsed[idx];
    if (line.isSegment) {
      removedSegments += 1;
      removedDuration += line.duration ?? 0;
    }
  });

  return {
    drop,
    removedSegments,
    removedDuration,
    removedBlocks: adBlocks.size,
    adBlockIndices: Array.from(adBlocks),
  };
}

/**
 * 智能分组过滤（参考 dongguaTV 判定规则 + 标准标记 + 域名/时长启发式 + 20% 保险丝）。
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
  const opts = {
    minAdDuration: options.minAdDuration ?? 3,
    maxAdDuration: options.maxAdDuration ?? 120,
    maxAdSegments: options.maxAdSegments ?? 15,
    maxRemovedRatio: options.maxRemovedRatio ?? 0.2,
    enableSuspiciousDomain: options.enableSuspiciousDomain ?? true,
    enableExplicitMarkers: options.enableExplicitMarkers ?? true,
  };

  const emptyStats = (fallback: boolean): SmartFilterStats => ({
    totalLines: 0,
    removedLines: 0,
    removedBlocks: 0,
    removedSegments: 0,
    removedDuration: 0,
    fallback,
  });

  if (!m3u8Content) {
    return { content: '', stats: emptyStats(false) };
  }

  // 主播放列表（多码率）原样返回
  if (isMasterPlaylist(m3u8Content)) {
    return {
      content: m3u8Content,
      stats: { ...emptyStats(true), totalLines: m3u8Content.split('\n').length },
    };
  }

  const parsed = parsePlaylist(m3u8Content);
  const blocks = collectBlocks(parsed);
  const totalSegments = blocks.reduce((sum, b) => sum + b.segments, 0);
  const totalDuration = blocks.reduce((sum, b) => sum + b.duration, 0);

  // 没有任何可切分组边界、也没有标准标记命中 → 走 legacy（通常无操作）
  const hasDiscontinuity = m3u8Content.includes('#EXT-X-DISCONTINUITY');
  const hasMarkers = /#EXT-X-CUE-OUT|#EXT-X-CUE-IN|#EXT-X-GAP|#EXT-X-CUE:/.test(m3u8Content);
  if (!hasDiscontinuity && !hasMarkers) {
    const legacy = filterAdsFromM3U8WithStats(m3u8Content);
    return {
      content: legacy.content,
      stats: { ...legacy.stats, removedBlocks: 0, removedSegments: 0, removedDuration: 0, fallback: true },
    };
  }

  const { drop, removedSegments, removedDuration, removedBlocks, adBlockIndices } = buildDropSet(parsed, blocks, opts);

  const ratioLimit = Math.max(opts.maxRemovedRatio, 0);
  const segmentRatio = totalSegments > 0 ? removedSegments / totalSegments : 0;
  const durationRatio = totalDuration > 0 ? removedDuration / totalDuration : 0;

  // 保险丝：删得太多就整体回退，宁可有广告不可没画面
  if (
    drop.size === 0 ||
    segmentRatio > ratioLimit ||
    durationRatio > ratioLimit
  ) {
    const legacy = filterAdsFromM3U8WithStats(m3u8Content);
    return {
      content: legacy.content,
      stats: { ...legacy.stats, removedBlocks: 0, removedSegments: 0, removedDuration: 0, fallback: true },
    };
  }

  // 重建播放列表：删除被标记行；仅清理被 DISCONTINUITY 分组判定为广告的块的前导标记
  const discontinuityIdxByBlock = new Map<number, number[]>();
  parsed.forEach((line, idx) => {
    if (!line.isDiscontinuity) return;
    const arr = discontinuityIdxByBlock.get(line.block) || [];
    arr.push(idx);
    discontinuityIdxByBlock.set(line.block, arr);
  });

  for (const blockIndex of adBlockIndices) {
    const markers = discontinuityIdxByBlock.get(blockIndex) || [];
    const own = markers[0];
    if (own !== undefined) drop.add(own);
  }

  const keptLines = parsed.filter((_, idx) => !drop.has(idx));

  return {
    content: keptLines.map((l) => l.raw).join('\n'),
    stats: {
      totalLines: parsed.length,
      removedLines: parsed.length - keptLines.length,
      removedBlocks,
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
