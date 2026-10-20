/**
 * 资源站健康探测（基于真实流量观测的自动降级）
 *
 * 不主动发起探测请求，而是在搜索扇出过程中记录每个源的成功/失败：
 *  - 连续失败达到阈值（默认 3 次）且在冷却期（默认 5 分钟）内 → 判定为不健康，搜索时跳过；
 *  - 任意一次成功 → 清零失败计数（恢复为健康）；
 *  - 冷却期过后自动放行重试，若仍不可用会再次进入不健康状态。
 *
 * 纯内存实现，serverless 多实例下按实例隔离（与 TtlCache 同理），
 * 配合响应头缓存仍能显著减少把请求打到已失效源站的概率。
 */

interface SourceHealthState {
  /** 连续失败次数 */
  consecutiveFails: number;
  /** 最近一次失败的时间戳（ms） */
  lastFailAt: number;
}

/** 连续失败达到该次数即判定不健康 */
const FAIL_THRESHOLD = 3;
/** 不健康冷却期：到期前保持跳过，到期后自动重试 */
const COOLDOWN_MS = 5 * 60 * 1000;

const health = new Map<string, SourceHealthState>();

/** 记录某源请求成功（清零失败计数） */
export function recordSourceSuccess(key: string): void {
  health.delete(key);
}

/** 记录某源请求失败（累加失败计数） */
export function recordSourceFailure(key: string): void {
  const prev = health.get(key);
  health.set(key, {
    consecutiveFails: (prev?.consecutiveFails ?? 0) + 1,
    lastFailAt: Date.now(),
  });
}

/**
 * 判断某源当前是否健康（是否应参与搜索扇出）。
 * 未知源（从未记录）默认健康；连续失败达标且在冷却期内 → 不健康。
 */
export function isSourceHealthy(key: string): boolean {
  const state = health.get(key);
  if (!state) return true;
  if (state.consecutiveFails < FAIL_THRESHOLD) return true;
  // 冷却期已过：放行重试，并清除以便重新计数
  if (Date.now() - state.lastFailAt > COOLDOWN_MS) {
    health.delete(key);
    return true;
  }
  return false;
}

/** 调试用：导出当前所有源的健康快照 */
export function getSourceHealthSnapshot(): Record<
  string,
  { consecutiveFails: number; lastFailAt: number; healthy: boolean }
> {
  const snapshot: Record<
    string,
    { consecutiveFails: number; lastFailAt: number; healthy: boolean }
  > = {};
  for (const [key, state] of health.entries()) {
    snapshot[key] = {
      consecutiveFails: state.consecutiveFails,
      lastFailAt: state.lastFailAt,
      healthy: isSourceHealthy(key),
    };
  }
  return snapshot;
}
