import { createWriteStream, type WriteStream } from 'node:fs'

type RecordingEntry = {
  sessionId: string
  filePath: string
  stream: WriteStream
}

/** Session-scoped UTF-8 append recorders. Phase2 can call append on each ssh:data. */
const recordings = new Map<string, RecordingEntry>()

export function startRecording(sessionId: string, filePath: string): void {
  const id = sessionId.trim()
  if (!id || !filePath.trim()) {
    throw new Error('startRecording requires sessionId and filePath')
  }
  stopRecording(id)
  const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
  recordings.set(id, { sessionId: id, filePath, stream })
}

export function appendRecording(sessionId: string, chunk: string): boolean {
  const entry = recordings.get(sessionId.trim())
  if (!entry || entry.stream.destroyed) return false
  if (!chunk) return true
  entry.stream.write(chunk)
  return true
}

/** Alias for callers that prefer appendChunk naming. */
export function appendChunk(sessionId: string, chunk: string): boolean {
  return appendRecording(sessionId, chunk)
}

export function stopRecording(sessionId: string): boolean {
  const id = sessionId.trim()
  const entry = recordings.get(id)
  if (!entry) return false
  recordings.delete(id)
  try {
    entry.stream.end()
  } catch {
    /* ignore close errors */
  }
  return true
}

export function isRecording(sessionId: string): boolean {
  return recordings.has(sessionId.trim())
}

export function getRecordingPath(sessionId: string): string | null {
  return recordings.get(sessionId.trim())?.filePath ?? null
}

export function stopAllRecordings(): void {
  for (const id of [...recordings.keys()]) {
    stopRecording(id)
  }
}

/** Small registry surface for Phase2 / ssh wrappers. */
export const RecordingRegistry = {
  start: startRecording,
  append: appendRecording,
  appendChunk,
  stop: stopRecording,
  isRecording,
  getPath: getRecordingPath,
  stopAll: stopAllRecordings
}
