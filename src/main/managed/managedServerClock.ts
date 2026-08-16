const MAX_TRUSTED_OFFSET_MS = 60_000

/** 服务端时钟快照，仅供 Main 内部调度和诊断使用。 */
export interface ManagedServerClockSnapshot {
  offsetMs: number
  trusted: boolean
}

/**
 * 根据标准 HTTP Date 响应头估算服务端时钟偏移。
 * 大偏差样本只保留诊断状态，不参与 Token 有效期延长。
 */
export class ManagedServerClock {
  private offsetMs = 0
  private trusted = false

  constructor(private readonly readLocalTime: () => number = Date.now) {}

  /** 返回未校正的本机时间，供请求往返测量使用。 */
  localTime(): number {
    return this.readLocalTime()
  }

  /** 使用请求往返中点估算偏移，忽略缺失或格式错误的 Date。 */
  observe(dateHeader: string | null, requestStartedAt: number, responseReceivedAt: number): void {
    if (!dateHeader) {
      return
    }
    const serverTime = Date.parse(dateHeader)
    if (
      Number.isNaN(serverTime) ||
      !Number.isFinite(requestStartedAt) ||
      !Number.isFinite(responseReceivedAt) ||
      responseReceivedAt < requestStartedAt
    ) {
      return
    }
    const midpoint = requestStartedAt + (responseReceivedAt - requestStartedAt) / 2
    this.offsetMs = serverTime - midpoint
    this.trusted = Math.abs(this.offsetMs) <= MAX_TRUSTED_OFFSET_MS
  }

  /** 返回用于 Token 调度的当前时间；不可信偏差不得延长凭据寿命。 */
  now(): number {
    const localTime = this.localTime()
    if (!this.trusted) {
      return localTime
    }
    // 服务端比本机慢时仍使用本机时间，避免通过负偏差延长 Token。
    return localTime + Math.max(0, this.offsetMs)
  }

  /** 返回不含请求、账号或凭据数据的诊断快照。 */
  getSnapshot(): ManagedServerClockSnapshot {
    return { offsetMs: this.offsetMs, trusted: this.trusted }
  }
}

export const managedMaximumTrustedClockOffsetMs = MAX_TRUSTED_OFFSET_MS
