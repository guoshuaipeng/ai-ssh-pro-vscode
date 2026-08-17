import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type KnownHostEntry = {
  hostPort: string
  fingerprint: string
  hostKeyBase64: string
  trustedAt: number
}

type KnownHostsFile = {
  entries: Record<string, KnownHostEntry>
}

function storePath(): string {
  return join(homedir(), '.ai-ssh-pro', 'known-hosts.json')
}

function ensureStore(): KnownHostsFile {
  const path = storePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(path)) {
    const empty: KnownHostsFile = { entries: {} }
    writeFileSync(path, `${JSON.stringify(empty, null, 2)}\n`, 'utf8')
    return empty
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as KnownHostsFile
  } catch {
    return { entries: {} }
  }
}

function saveStore(data: KnownHostsFile): void {
  const path = storePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function hostPortKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`
}

export function fingerprintSha256(hostKey: Buffer): string {
  const b64 = createHash('sha256').update(hostKey).digest('base64')
  return `SHA256:${b64}`
}

export function getKnownHost(host: string, port: number): KnownHostEntry | null {
  const key = hostPortKey(host, port)
  return ensureStore().entries[key] ?? null
}

export function trustHostKey(host: string, port: number, hostKey: Buffer): KnownHostEntry {
  const key = hostPortKey(host, port)
  const entry: KnownHostEntry = {
    hostPort: key,
    fingerprint: fingerprintSha256(hostKey),
    hostKeyBase64: hostKey.toString('base64'),
    trustedAt: Date.now()
  }
  const data = ensureStore()
  data.entries = { ...data.entries, [key]: entry }
  saveStore(data)
  return entry
}

export function removeKnownHost(host: string, port: number): void {
  const key = hostPortKey(host, port)
  const data = ensureStore()
  const entries = { ...data.entries }
  delete entries[key]
  data.entries = entries
  saveStore(data)
}

export type HostKeyCheckResult =
  | { status: 'trusted' }
  | { status: 'unknown'; fingerprint: string; hostKey: Buffer }
  | { status: 'changed'; fingerprint: string; previousFingerprint: string; hostKey: Buffer }

export function checkHostKey(host: string, port: number, hostKey: Buffer): HostKeyCheckResult {
  const fp = fingerprintSha256(hostKey)
  const known = getKnownHost(host, port)
  if (!known) {
    return { status: 'unknown', fingerprint: fp, hostKey }
  }
  if (known.hostKeyBase64 === hostKey.toString('base64')) {
    return { status: 'trusted' }
  }
  return {
    status: 'changed',
    fingerprint: fp,
    previousFingerprint: known.fingerprint,
    hostKey
  }
}
