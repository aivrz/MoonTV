import {
  createAdFilterHlsLoader,
  filterAdsFromM3U8,
  filterAdsFromM3U8Smart,
  filterAdsFromM3U8SmartWithStats,
  filterAdsFromM3U8WithStats,
} from './m3u8-ad-filter';

const SAMPLE_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:10.000,',
  'seg1.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:5.000,',
  'ad-seg.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:10.000,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

// ---------- smart 分组过滤测试夹具 ----------

/** 典型 VOD：40 个正片分片 + 1 个广告组（3×10s），广告占比 4% 不触发保险丝 */
const SMART_FIXTURE = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  ...Array.from(
    { length: 30 },
    (_, i) => `#EXTINF:10.000,\nseg-${i}.ts`
  ),
  '#EXT-X-DISCONTINUITY',
  ...Array.from({ length: 3 }, (_, i) => `#EXTINF:10.000,\nad-${i}.ts`),
  '#EXT-X-DISCONTINUITY',
  ...Array.from(
    { length: 30 },
    (_, i) => `#EXTINF:10.000,\nseg-b-${i}.ts`
  ),
  '#EXT-X-ENDLIST',
  '',
].join('\n');

/**
 * 保险丝场景：两段各 15 片×10s=150s 的正片（分片数 >=15，不判广告）
 * + 一组 10 片×10s=100s 的广告，删除占比 100/400 = 25% > 20%，触发保险丝整体回退。
 */
const FUSE_FIXTURE = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:10',
  ...Array.from({ length: 15 }, (_, i) => `#EXTINF:10.000,\nm-${i}.ts`),
  '#EXT-X-DISCONTINUITY',
  ...Array.from({ length: 10 }, (_, i) => `#EXTINF:10.000,\nad-${i}.ts`),
  '#EXT-X-DISCONTINUITY',
  ...Array.from({ length: 15 }, (_, i) => `#EXTINF:10.000,\nm-b-${i}.ts`),
  '#EXT-X-ENDLIST',
  '',
].join('\n');

describe('filterAdsFromM3U8', () => {
  it('removes EXT-X-DISCONTINUITY marker lines', () => {
    const result = filterAdsFromM3U8(SAMPLE_PLAYLIST);

    expect(result).not.toContain('#EXT-X-DISCONTINUITY');
    // 其余行（含广告分段的 EXTINF 与 URL）保持原样
    expect(result).toContain('#EXTINF:10.000,');
    expect(result).toContain('ad-seg.ts');
    expect(result).toContain('#EXT-X-ENDLIST');
  });

  it('keeps playlists without discontinuities untouched', () => {
    const playlist = ['#EXTM3U', '#EXTINF:9.0,', 'a.ts', '#EXT-X-ENDLIST'].join(
      '\n'
    );

    expect(filterAdsFromM3U8(playlist)).toBe(playlist);
  });

  it('handles CRLF line endings', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:4.000,',
      'a.ts',
    ].join('\r\n');

    const result = filterAdsFromM3U8(playlist);

    expect(result).not.toContain('#EXT-X-DISCONTINUITY');
    expect(result).toContain('a.ts');
  });

  it('returns empty string for empty content', () => {
    expect(filterAdsFromM3U8('')).toBe('');
  });
});

describe('filterAdsFromM3U8WithStats', () => {
  it('reports total and removed line counts', () => {
    const { content, stats } = filterAdsFromM3U8WithStats(SAMPLE_PLAYLIST);

    expect(stats.totalLines).toBe(SAMPLE_PLAYLIST.split('\n').length);
    expect(stats.removedLines).toBe(2);
    expect(content).toBe(filterAdsFromM3U8(SAMPLE_PLAYLIST));
  });

  it('reports zero removed lines for clean playlists', () => {
    const { stats } = filterAdsFromM3U8WithStats('#EXTM3U\n#EXTINF:9.0,\na.ts');

    expect(stats.removedLines).toBe(0);
  });
});

describe('filterAdsFromM3U8Smart', () => {
  it('removes the ad group between discontinuities and keeps main segments', () => {
    const result = filterAdsFromM3U8Smart(SMART_FIXTURE);

    expect(result).not.toContain('ad-');
    for (let i = 0; i < 30; i++) expect(result).toContain(`seg-${i}.ts`);
    for (let i = 0; i < 30; i++) expect(result).toContain(`seg-b-${i}.ts`);
    expect(result).toContain('#EXT-X-ENDLIST');
    // 正片分片数量不受影响（30 + 30）
    expect(result.match(/#EXTINF/g)?.length).toBe(60);
    // 广告组 opener 标记被删，但正片之间保留恰好一个 DISCONTINUITY，
    // 避免正片前后两段时间轴跳变被当成连续流（防 bufferAppendError）
    expect(result.match(/#EXT-X-DISCONTINUITY/g)?.length ?? 0).toBe(1);
  });

  it('reports accurate stats for removed ad groups', () => {
    const { stats } = filterAdsFromM3U8SmartWithStats(SMART_FIXTURE);

    expect(stats.removedBlocks).toBe(1);
    expect(stats.removedSegments).toBe(3);
    expect(stats.removedDuration).toBe(30);
    expect(stats.fallback).toBe(false);
    expect(stats.removedLines).toBe(7); // 3×EXTINF + 3×URL + 1×DISCONTINUITY
  });

  it('falls back to legacy when the fuse trips (too much to remove)', () => {
    const { content, stats } = filterAdsFromM3U8SmartWithStats(FUSE_FIXTURE);

    expect(stats.fallback).toBe(true);
    expect(stats.removedSegments).toBe(0);
    // 回退后只删标记行，广告分段仍在（宁可有广告不可没画面）
    expect(content).not.toContain('#EXT-X-DISCONTINUITY');
    expect(content).toContain('ad-0.ts');
    expect(content).toBe(filterAdsFromM3U8(FUSE_FIXTURE));
  });

  it('does not treat long groups (>120s or >=15 segments) as ads', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      // 正片段落 1：15 片 × 10s（分片数 >= 15，不判广告）
      ...Array.from({ length: 15 }, (_, i) => `#EXTINF:10.000,\nm0-${i}.ts`),
      '#EXT-X-DISCONTINUITY',
      // 中段：20 个分片 × 10s = 200s：超时长上限，且分片数 >= 15
      ...Array.from({ length: 20 }, (_, i) => `#EXTINF:10.000,\nlong-${i}.ts`),
      '#EXT-X-DISCONTINUITY',
      // 正片段落 2：15 片 × 10s
      ...Array.from({ length: 15 }, (_, i) => `#EXTINF:10.000,\nm1-${i}.ts`),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const { content, stats } = filterAdsFromM3U8SmartWithStats(playlist);

    expect(stats.removedSegments).toBe(0);
    expect(stats.fallback).toBe(true);
    expect(content).toContain('long-0.ts');
    expect(content).not.toContain('#EXT-X-DISCONTINUITY');
  });

  it('returns master playlists untouched', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2560000',
      'high/index.m3u8',
    ].join('\n');

    expect(filterAdsFromM3U8Smart(master)).toBe(master);
  });

  it('handles CRLF line endings', () => {
    const crlf = SMART_FIXTURE.replace(/\n/g, '\r\n');
    const result = filterAdsFromM3U8Smart(crlf);

    expect(result).not.toContain('ad-');
    // 广告 opener 标记已删，正片之间保留一个标记
    expect(result.match(/#EXT-X-DISCONTINUITY/g)?.length ?? 0).toBe(1);
    expect(result).toContain('seg-0.ts');
  });

  it('is a no-op for playlists without discontinuities', () => {
    const playlist = '#EXTM3U\n#EXTINF:9.0,\na.ts\n#EXT-X-ENDLIST';

    expect(filterAdsFromM3U8Smart(playlist)).toBe(playlist);
  });

  it('returns empty string for empty content', () => {
    expect(filterAdsFromM3U8Smart('')).toBe('');
  });
});

describe('createAdFilterHlsLoader', () => {
  function createLoaderInstance() {
    const baseLoaded: any[] = [];
    const fakeHls = {
      DefaultConfig: {
        loader: class {
          config: any;
          constructor(config: any) {
            this.config = config;
          }
          load(context: any, config: any, callbacks: any) {
            baseLoaded.push({ context, config, callbacks });
          }
        },
      },
    };
    const Loader = createAdFilterHlsLoader(fakeHls);
    const instance = new Loader({});
    return { instance, baseLoaded };
  }

  it('filters m3u8 content on manifest/level success', () => {
    const { instance } = createLoaderInstance();
    const onSuccess = jest.fn();
    const callbacks = { onSuccess };

    instance.load({ type: 'manifest' }, {}, callbacks);
    // load 执行后 onSuccess 已被包装
    const response = { data: SAMPLE_PLAYLIST };
    callbacks.onSuccess(response, {}, {});

    expect(response.data).not.toContain('#EXT-X-DISCONTINUITY');
    expect(onSuccess).toHaveBeenCalledWith(response, {}, {}, null);
  });

  it('leaves fragment requests untouched', () => {
    const { instance } = createLoaderInstance();
    const onSuccess = jest.fn();
    const callbacks = { onSuccess };

    instance.load({ type: 'fragment' }, {}, callbacks);

    expect(callbacks.onSuccess).toBe(onSuccess);
  });

  it('ignores non-string response data', () => {
    const { instance } = createLoaderInstance();
    const onSuccess = jest.fn();
    const callbacks = { onSuccess };

    instance.load({ type: 'level' }, {}, callbacks);
    const response = { data: new ArrayBuffer(8) };
    callbacks.onSuccess(response, {}, {});

    expect(response.data).toBeInstanceOf(ArrayBuffer);
    expect(onSuccess).toHaveBeenCalled();
  });

  it('uses smart filtering by default and reports stats', () => {
    const onStats = jest.fn();
    const fakeHls = {
      DefaultConfig: {
        loader: class {
          constructor(_config: any) {
            /* mock: 不实现 */
          }
          load(_context: any, _config: any, _callbacks: any) {
            /* mock: 不实现 */
          }
        },
      },
    };
    const instance = new (createAdFilterHlsLoader(fakeHls, { onStats }))({});
    const onSuccess = jest.fn();
    const callbacks = { onSuccess };

    instance.load({ type: 'manifest' }, {}, callbacks);
    const response = { data: SMART_FIXTURE };
    callbacks.onSuccess(response, {}, {});

    expect(response.data).not.toContain('ad-');
    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({ removedSegments: 3, fallback: false })
    );
  });

  it('legacy mode keeps ad segments and only strips markers', () => {
    const fakeHls = {
      DefaultConfig: {
        loader: class {
          constructor(_config: any) {
            /* mock: 不实现 */
          }
          load(_context: any, _config: any, _callbacks: any) {
            /* mock: 不实现 */
          }
        },
      },
    };
    const instance = new (createAdFilterHlsLoader(fakeHls, {
      mode: 'legacy',
    }))({});
    const onSuccess = jest.fn();
    const callbacks = { onSuccess };

    instance.load({ type: 'manifest' }, {}, callbacks);
    const response = { data: SMART_FIXTURE };
    callbacks.onSuccess(response, {}, {});

    expect(response.data).toContain('ad-0.ts');
    expect(response.data).not.toContain('#EXT-X-DISCONTINUITY');
  });
});
