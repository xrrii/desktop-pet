/**
 * 合并使用同一旧 Refresh Token 的并发操作，防止轮换 Token 被重复提交。
 * Token 只作为内存中的相等性键使用，不写入日志或外部状态。
 */
export class ManagedRefreshCoordinator<Result> {
  private active: { refreshToken: string; task: Promise<Result> } | null = null

  /** 同一旧 Token 复用正在执行的 Promise，不同 Token 在上一轮结束后再开始。 */
  run(refreshToken: string, operation: () => Promise<Result>): Promise<Result> {
    const active = this.active
    if (active) {
      if (active.refreshToken === refreshToken) {
        return active.task
      }
      return active.task.catch(() => undefined).then(() => this.run(refreshToken, operation))
    }

    const task = operation().finally(() => {
      if (this.active?.task === task) {
        this.active = null
      }
    })
    this.active = { refreshToken, task }
    return task
  }

  /** 等待当前底层刷新结束，供退出和设备撤销串行化生命周期。 */
  async waitForIdle(): Promise<void> {
    await this.active?.task.then(() => undefined, () => undefined)
  }

  /** 返回当前是否存在底层 Refresh Token Grant。 */
  isActive(): boolean {
    return this.active !== null
  }
}
