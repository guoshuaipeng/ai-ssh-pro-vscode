export type SessionEventSink = {
  sendData(sessionId: string, chunk: string | Uint8Array): void
  sendStatus(sessionId: string, status: 'connected' | 'error' | 'closed', message?: string): void
  isAlive(): boolean
}
