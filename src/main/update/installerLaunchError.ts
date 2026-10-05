/** 无法确认安装器已结束时携带退出通知，调用方必须保持任务互锁。 */
export class InstallerProcessPendingError extends Error {
  /** 退出通知只代表本次安装进程已结束，不代表安装成功。 */
  constructor(readonly closed: Promise<void>) {
    super('安装器仍未确认结束，请关闭安装窗口后再试。')
  }
}
