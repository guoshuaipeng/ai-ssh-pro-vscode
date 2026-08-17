/** 按行环形缓冲，供 Agent /「最近输出」读取 */
export class RingBuffer {
  private lines: string[] = []
  private partial = ''
  private startAbsLine = 0

  constructor(private readonly maxLines: number) {}

  appendUtf8(chunk: string): void {
    this.partial += chunk
    const parts = this.partial.split('\n')
    this.partial = parts.pop() ?? ''
    for (const line of parts) {
      this.lines.push(line)
      if (this.lines.length > this.maxLines) {
        const removed = this.lines.length - this.maxLines
        this.lines.splice(0, removed)
        this.startAbsLine += removed
      }
    }
  }

  /** 连接关闭时把尾部不完整行写入 */
  flushPartial(): void {
    if (this.partial.length > 0) {
      this.lines.push(this.partial)
      this.partial = ''
      if (this.lines.length > this.maxLines) {
        const removed = this.lines.length - this.maxLines
        this.lines.splice(0, removed)
        this.startAbsLine += removed
      }
    }
  }

  getSnapshot(maxLines = 200): string {
    const combined = this.snapshotLinesWithPartial()
    const n = Math.min(maxLines, combined.length)
    return combined.slice(-n).join('\n')
  }

  clear(): void {
    this.lines = []
    this.partial = ''
    this.startAbsLine = 0
  }

  /** 当前 ring 内最后一行（不含 partial）的绝对行号+1 */
  getTotalLineCount(): number {
    return this.startAbsLine + this.lines.length
  }

  /** 从绝对行号起截取快照（含该行）；若该行已被 ring 淘汰，会从当前最早可用行开始 */
  getSnapshotFromAbsoluteLine(absLineStart: number, maxLines = 200): string {
    const combined = this.snapshotLinesWithPartial()
    const safeStart = Math.max(this.startAbsLine, Math.floor(absLineStart))
    const startIdx = Math.max(0, safeStart - this.startAbsLine)
    const slice = combined.slice(startIdx)
    if (maxLines > 0 && slice.length > maxLines) {
      return slice.slice(-maxLines).join('\n')
    }
    return slice.join('\n')
  }

  private snapshotLinesWithPartial(): string[] {
    const out = [...this.lines]
    if (this.partial.length > 0) out.push(this.partial)
    return out
  }
}
