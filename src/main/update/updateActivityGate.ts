/** 统一记录 Main 在途操作，并在安装准备期间阻止新操作进入。 */
export class UpdateActivityGate {
  private active = 0
  private reserved = false

  /** 执行受保护操作；原生对话框、文件写入和 IPC 的完整异步周期都计入忙碌。 */
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.reserved) {
      throw new Error('正在准备安装更新，请稍后再试。')
    }
    this.active += 1
    try {
      return await operation()
    } finally {
      this.active -= 1
    }
  }

  /** 仅在没有在途操作时同步预留安装，消除检查后又进入新任务的竞态。 */
  reserve(): boolean {
    if (this.reserved || this.active !== 0) {
      return false
    }
    this.reserved = true
    return true
  }

  /** 安装被延后或准备失败时重新开放操作。 */
  release(): void {
    this.reserved = false
  }

  /** 返回不含任务正文或文件路径的安装互锁状态。 */
  snapshot(): { active: number; reserved: boolean } {
    return { active: this.active, reserved: this.reserved }
  }
}
