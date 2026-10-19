/**
 * 服务端数据缓存 + in-flight 请求合并
 *
 * 背景：搜索接口一次要扇出到全部资源站（默认 21 个源 × 最多 5 页），
 * 没有结果缓存时，同一个关键词的每次请求都会把上游全部重放一遍。
 * 本模块提供：
 *  1. TTL 缓存（带容量上限，FIFO 淘汰，命中后刷新位置）
 *  2. in-flight 请求合并——同一 key 的并发请求共享同一个 Promise，防止缓存击穿
 *
 * 纯内存实现，只使用 Map/WeakMap，可同时运行于 Node runtime（Docker）
 * 与 Edge runtime（Vercel / Cloudflare Pages）。serverless 场景下按实例隔离，
 * 配合响应头的 CDN Cache-Control 仍能显著削减回源与上游压力。
 */

export interface TtlCacheOptions {
  /** 缓存条目容量上限，超出后按 FIFO 淘汰 */
  maxEntries?: number;
}

/** 带 TTL 与容量上限的内存缓存 */
export class TtlCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  private readonly maxEntries: number;

  constructor(options: TtlCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // 命中后刷新 FIFO 位置，让热 key 靠后、减少被淘汰的概率
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });

    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  get size(): number {
    return this.store.size;
  }
}

export function createTtlCache<T>(options?: TtlCacheOptions): TtlCache<T> {
  return new TtlCache<T>(options);
}

/** 搜索结果缓存：value 可能较大（全源聚合结果），容量适中 */
export const searchResultCache = createTtlCache<unknown>({
  maxEntries: 300,
});

/** 视频详情缓存：按 source+id 维度，容量小于搜索缓存 */
export const videoDetailCache = createTtlCache<unknown>({
  maxEntries: 200,
});

// 每个缓存实例维护自己的 in-flight 表，避免不同缓存之间互相串扰
const inFlightByCache = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * 带缓存与 in-flight 合并的执行器。
 *
 * 执行顺序：缓存命中 → 合并在途请求 → 未命中才真正执行 producer。
 * producer 失败不会写入缓存，错误直接抛给调用方（由路由层决定兜底）。
 */
export async function runWithCache<T>(
  cache: TtlCache<unknown>,
  key: string,
  ttlMs: number,
  producer: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key) as T | undefined;
  if (cached !== undefined) return cached;

  let inFlight = inFlightByCache.get(cache);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByCache.set(cache, inFlight);
  }

  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await producer();
      cache.set(key, value, ttlMs);
      return value;
    } finally {
      inFlight!.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * 搜索结果缓存 TTL：取配置 cache_time 的 1/4，收敛到 [60s, 30min]。
 * 搜索结果不需要太长的新鲜度保证，同时避免源站内容更新后缓存太久。
 */
export function resolveSearchCacheTtlMs(cacheTimeSeconds: number): number {
  const raw = Math.floor(cacheTimeSeconds / 4) * 1000;
  return Math.min(30 * 60 * 1000, Math.max(60 * 1000, raw));
}
