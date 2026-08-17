import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type {
  SshConnectOptions,
  SshConnectResult,
  SessionMeta,
  SshSnapshotOptions,
  SshJumpHostOptions
} from '../shared/ipc'
import { RingBuffer } from './ring-buffer'
import { checkHostKey, trustHostKey } from './known-hosts'
import { promptHostKey } from './host-key'
import { startLocalPortForwards } from './port-forward'
import { appendRecording } from './session-recorder'
import { assertSafeDockerId } from './docker-manager'
import type { SessionEventSink } from './session-events'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32
const RING_MAX_LINES = 4000
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3

/** 与 OpenSSH 类似：未指定私钥时尝试默认路径（仅在没有密码时） */
const DEFAULT_PRIVATE_KEY_NAMES = ['id_ed25519', 'id_rsa', 'id_ecdsa'] as const

async function tryReadDefaultPrivateKey(): Promise<Buffer | null> {
  const base = join(homedir(), '.ssh')
  for (const name of DEFAULT_PRIVATE_KEY_NAMES) {
    const fp = join(base, name)
    if (!existsSync(fp)) continue
    try {
      return await readFile(fp)
    } catch {
      /* 忽略无权限等 */
    }
  }
  return null
}

type AuthFields = {
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

async function applyAuth(
  connectConfig: ConnectConfig,
  auth: AuthFields,
  opts: { allowDefaultKey: boolean }
): Promise<void> {
  if (auth.password) {
    connectConfig.password = auth.password
  }
  if (auth.privateKeyPath?.trim()) {
    const keyPath = auth.privateKeyPath.trim()
    connectConfig.privateKey = await readFile(keyPath)
    if (auth.passphrase) {
      connectConfig.passphrase = auth.passphrase
    }
  } else if (!auth.password && opts.allowDefaultKey) {
    const fallbackKey = await tryReadDefaultPrivateKey()
    if (fallbackKey) {
      connectConfig.privateKey = fallbackKey
      if (auth.passphrase) {
        connectConfig.passphrase = auth.passphrase
      }
    }
  }
}

function makeHostVerifier(host: string, port: number): ConnectConfig['hostVerifier'] {
  return (key: Buffer, verify: (ok: boolean) => void) => {
    void (async () => {
      try {
        const result = checkHostKey(host, port, key)
        if (result.status === 'trusted') {
          verify(true)
          return
        }

        const decision = await promptHostKey({
          host,
          port,
          fingerprint: result.fingerprint,
          reason: result.status,
          previousFingerprint: result.status === 'changed' ? result.previousFingerprint : undefined
        })

        if (!decision.accept) {
          verify(false)
          return
        }

        if (decision.alwaysTrust) {
          trustHostKey(host, port, key)
        }
        verify(true)
      } catch (e) {
        console.error('[ssh] hostVerifier error:', e)
        verify(false)
      }
    })()
  }
}

function connectClient(client: Client, config: ConnectConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const ok = () => {
      if (settled) return
      settled = true
      resolve()
    }

    client.once('ready', ok)
    client.once('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (/verification failed|host key/i.test(msg)) {
        fail(new Error('主机密钥未通过验证（已取消连接或指纹不匹配）'))
        return
      }
      fail(err instanceof Error ? err : new Error(String(err)))
    })

    try {
      client.connect(config)
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

function forwardOutToTarget(
  jumpClient: Client,
  targetHost: string,
  targetPort: number
): Promise<import('stream').Duplex> {
  return new Promise((resolve, reject) => {
    jumpClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('跳板机无法转发到目标主机'))
        return
      }
      resolve(stream)
    })
  })
}

export type ManagedSession = {
  sessionId: string
  meta: SessionMeta
  client: Client
  stream: ClientChannel
  ring: RingBuffer
  owner: SessionEventSink
  commandMarkers: Array<{ command: string; at: number; lineCount: number }>
  pendingInput: string
  /** 用于重连；含认证信息，仅存内存 */
  connectOpts: SshConnectOptions
  jumpClient?: Client
  forwardCleanups: Array<() => void>
  /** false：复用父会话 Client（如 docker exec），断开时不 end 父连接 */
  ownsClient: boolean
  profileId?: string
}

export class SshSessionManager {
  private sessions = new Map<string, ManagedSession>()

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** 供 SFTP 等复用同一会话的 ssh2 Client（目标机） */
  getClient(sessionId: string): Client | undefined {
    return this.sessions.get(sessionId)?.client
  }

  listMeta(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }))
  }

  getRingSnapshot(sessionId: string, options?: number | SshSnapshotOptions): string | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    const opt = typeof options === 'number' ? { maxLines: options } : options ?? {}
    const maxLines = Number.isFinite(opt.maxLines) ? Math.min(4000, Math.max(1, Math.floor(opt.maxLines!))) : 200
    if (!opt.fromCurrentCommand) {
      return s.ring.getSnapshot(maxLines)
    }
    const last = s.commandMarkers[s.commandMarkers.length - 1]
    if (!last) return s.ring.getSnapshot(maxLines)
    const body = s.ring.getSnapshotFromAbsoluteLine(last.lineCount, maxLines)
    if (!body.trim()) {
      const fallback = s.ring.getSnapshot(maxLines)
      if (fallback.trim()) return fallback
    }
    if (opt.includeCommandLine === false) return body
    const prefix = `$ ${last.command}`
    return body.trim() ? `${prefix}\n${body}` : `${prefix}\n（命令已发送，暂未捕获到后续输出）`
  }

  private trackWriteCommand(s: ManagedSession, data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!
      if (ch === '\r' || ch === '\n') {
        const cmd = s.pendingInput.trim()
        if (cmd) {
          s.commandMarkers.push({ command: cmd, at: Date.now(), lineCount: s.ring.getTotalLineCount() })
          if (s.commandMarkers.length > 60) s.commandMarkers = s.commandMarkers.slice(-60)
        }
        s.pendingInput = ''
        continue
      }
      if (ch === '\u007f' || ch === '\b') {
        s.pendingInput = s.pendingInput.slice(0, -1)
        continue
      }
      if (ch >= ' ' && ch !== '\u0000') {
        s.pendingInput += ch
        if (s.pendingInput.length > 400) {
          s.pendingInput = s.pendingInput.slice(-400)
        }
      }
    }
  }

  private runForwardCleanups(s: ManagedSession): void {
    const cleanups = s.forwardCleanups.splice(0, s.forwardCleanups.length)
    for (const fn of cleanups) {
      try {
        fn()
      } catch {
        /* ignore */
      }
    }
  }

  private endClients(s: Pick<ManagedSession, 'client' | 'jumpClient'>): void {
    try {
      s.client.end()
    } catch {
      /* ignore */
    }
    if (s.jumpClient) {
      try {
        s.jumpClient.end()
      } catch {
        /* ignore */
      }
    }
  }

  private teardownSession(sessionId: string, s: ManagedSession): void {
    this.runForwardCleanups(s)
    if (s.ownsClient) this.endClients(s)
    this.sessions.delete(sessionId)
  }

  async connect(
    opts: SshConnectOptions,
    owner: SessionEventSink,
    extra?: { profileId?: string }
  ): Promise<SshConnectResult> {
    const host = opts.host.trim()
    const port = opts.port ?? 22
    const username = opts.username.trim()
    if (!host || !username) {
      throw new Error('host 与 username 不能为空')
    }

    const cols = opts.termCols ?? DEFAULT_COLS
    const rows = opts.termRows ?? DEFAULT_ROWS
    const sessionId = randomUUID()
    const connectedAt = Date.now()

    const meta: SessionMeta = {
      host,
      port,
      username,
      label: opts.label?.trim() || `${username}@${host}`,
      connectedAt,
      termCols: cols,
      termRows: rows
    }

    const jump = opts.jumpHost
    let jumpClient: Client | undefined
    const targetClient = new Client()

    const failCleanup = () => {
      try {
        targetClient.end()
      } catch {
        /* ignore */
      }
      if (jumpClient) {
        try {
          jumpClient.end()
        } catch {
          /* ignore */
        }
      }
    }

    try {
      if (jump?.host?.trim() && jump.username?.trim()) {
        const jHost = jump.host.trim()
        const jPort = jump.port ?? 22
        const jUser = jump.username.trim()
        jumpClient = new Client()

        const jumpConfig: ConnectConfig = {
          host: jHost,
          port: jPort,
          username: jUser,
          readyTimeout: 20000,
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          hostVerifier: makeHostVerifier(jHost, jPort)
        }
        await applyAuth(jumpConfig, jump as SshJumpHostOptions, { allowDefaultKey: true })
        if (!jumpConfig.password && !jumpConfig.privateKey) {
          throw new Error(
            '跳板机请提供密码或私钥路径；若留空，请在本机用户目录 .ssh 下放置默认私钥'
          )
        }
        await connectClient(jumpClient, jumpConfig)

        const sock = await forwardOutToTarget(jumpClient, host, port)

        const targetConfig: ConnectConfig = {
          sock,
          username,
          readyTimeout: 20000,
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          hostVerifier: makeHostVerifier(host, port)
        }
        await applyAuth(targetConfig, opts, { allowDefaultKey: true })
        if (!targetConfig.password && !targetConfig.privateKey) {
          throw new Error(
            '请提供密码或私钥路径；若留空，请在本机用户目录 .ssh 下放置 id_ed25519、id_rsa 或 id_ecdsa（与 OpenSSH 默认行为一致）'
          )
        }
        await connectClient(targetClient, targetConfig)
      } else {
        const connectConfig: ConnectConfig = {
          host,
          port,
          username,
          readyTimeout: 20000,
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          hostVerifier: makeHostVerifier(host, port)
        }
        await applyAuth(connectConfig, opts, { allowDefaultKey: true })
        if (!connectConfig.password && !connectConfig.privateKey) {
          throw new Error(
            '请提供密码或私钥路径；若留空，请在本机用户目录 .ssh 下放置 id_ed25519、id_rsa 或 id_ecdsa（与 OpenSSH 默认行为一致）'
          )
        }
        await connectClient(targetClient, connectConfig)
      }
    } catch (e) {
      failCleanup()
      throw e instanceof Error ? e : new Error(String(e))
    }

    const normalizedOpts: SshConnectOptions = {
      ...opts,
      host,
      port,
      username,
      termCols: cols,
      termRows: rows
    }

    return await new Promise<SshConnectResult>((resolve, reject) => {
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        failCleanup()
        reject(err)
      }

      targetClient.shell(
        {
          cols,
          rows,
          term: 'xterm-256color'
        },
        (err, stream) => {
          if (err || !stream) {
            fail(err ?? new Error('无法打开 shell'))
            return
          }

          const ring = new RingBuffer(RING_MAX_LINES)
          const forwardCleanups: Array<() => void> = []

          const session: ManagedSession = {
            sessionId,
            meta,
            client: targetClient,
            stream,
            ring,
            owner,
            commandMarkers: [],
            pendingInput: '',
            connectOpts: normalizedOpts,
            jumpClient,
            forwardCleanups,
            ownsClient: true,
            profileId: extra?.profileId
          }

          stream.on('data', (buf: Buffer) => {
            const asText = buf.toString('utf8')
            ring.appendUtf8(asText)
            appendRecording(sessionId, asText)
            if (owner.isAlive()) {
              owner.sendData(sessionId, buf)
            }
          })

          stream.on('close', () => {
            ring.flushPartial()
            if (owner.isAlive()) {
              owner.sendStatus(sessionId, 'closed', '连接已断开')
            }
            this.teardownSession(sessionId, session)
          })

          stream.stderr?.on('data', (buf: Buffer) => {
            const asText = buf.toString('utf8')
            ring.appendUtf8(asText)
            appendRecording(sessionId, asText)
            if (owner.isAlive()) {
              owner.sendData(sessionId, buf)
            }
          })

          // 目标机 ready 后建立本地端口转发
          if (opts.forwards?.length) {
            try {
              const cleanups = startLocalPortForwards(targetClient, opts.forwards)
              forwardCleanups.push(...cleanups)
            } catch (e) {
              console.error('[ssh] port forwards failed:', e)
            }
          }

          this.sessions.set(sessionId, session)

          if (owner.isAlive()) {
            owner.sendStatus(sessionId, 'connected')
          }

          if (!settled) {
            settled = true
            resolve({ sessionId, meta })
          }
        }
      )
    })
  }

  write(sessionId: string, data: string | Uint8Array): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    if (typeof data === 'string') {
      this.trackWriteCommand(s, data)
      return s.stream.write(data)
    }
    return s.stream.write(Buffer.from(data))
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    try {
      const heightPx = Math.max(rows * 20, 1)
      const widthPx = Math.max(cols * 10, 1)
      s.stream.setWindow(rows, cols, heightPx, widthPx)
      s.meta.termCols = cols
      s.meta.termRows = rows
      return true
    } catch {
      return false
    }
  }

  disconnect(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.runForwardCleanups(s)
    try {
      s.stream.close()
    } catch {
      /* ignore */
    }
    if (s.ownsClient) this.endClients(s)
    this.sessions.delete(sessionId)
  }

  /**
   * 在已连接 SSH 上打开 docker exec 交互终端（复用同一 Client，不新建 TCP）。
   */
  async openDockerExec(
    parentSessionId: string,
    containerId: string,
    owner: SessionEventSink,
    opts?: { termCols?: number; termRows?: number; label?: string }
  ): Promise<SshConnectResult> {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父 SSH 会话不存在或未连接')

    const id = assertSafeDockerId(containerId, '容器')
    const cols = opts?.termCols ?? parent.meta.termCols ?? DEFAULT_COLS
    const rows = opts?.termRows ?? parent.meta.termRows ?? DEFAULT_ROWS
    const sessionId = randomUUID()
    const label = opts?.label?.trim() || `docker exec ${id.slice(0, 12)}`
    const meta: SessionMeta = {
      host: parent.meta.host,
      port: parent.meta.port,
      username: parent.meta.username,
      label,
      connectedAt: Date.now(),
      termCols: cols,
      termRows: rows
    }

    // Prefer bash, fall back to sh; -i keeps a login-ish interactive shell.
    const remoteCmd = `docker exec -it ${id} sh -lc 'if command -v bash >/dev/null 2>&1; then exec bash -i; else exec sh -i; fi'`

    return await new Promise<SshConnectResult>((resolve, reject) => {
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }

      parent.client.exec(
        remoteCmd,
        {
          pty: {
            term: 'xterm-256color',
            cols,
            rows
          }
        },
        (err, stream) => {
          if (err || !stream) {
            fail(err ?? new Error('无法打开 docker exec'))
            return
          }

          const ring = new RingBuffer(RING_MAX_LINES)
          const session: ManagedSession = {
            sessionId,
            meta,
            client: parent.client,
            stream,
            ring,
            owner,
            commandMarkers: [],
            pendingInput: '',
            connectOpts: parent.connectOpts,
            jumpClient: undefined,
            forwardCleanups: [],
            ownsClient: false,
            profileId: parent.profileId
          }

          stream.on('data', (buf: Buffer) => {
            const asText = buf.toString('utf8')
            ring.appendUtf8(asText)
            appendRecording(sessionId, asText)
            if (owner.isAlive()) {
              owner.sendData(sessionId, buf)
            }
          })

          stream.stderr?.on('data', (buf: Buffer) => {
            const asText = buf.toString('utf8')
            ring.appendUtf8(asText)
            appendRecording(sessionId, asText)
            if (owner.isAlive()) {
              owner.sendData(sessionId, buf)
            }
          })

          stream.on('close', () => {
            ring.flushPartial()
            if (owner.isAlive()) {
              owner.sendStatus(sessionId, 'closed', '容器终端已退出')
            }
            this.teardownSession(sessionId, session)
          })

          this.sessions.set(sessionId, session)

          if (owner.isAlive()) {
            owner.sendStatus(sessionId, 'connected')
          }

          if (!settled) {
            settled = true
            resolve({ sessionId, meta })
          }
        }
      )
    })
  }

  /** 退出应用前断开全部 SSH，避免进程挂起 */
  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.disconnect(id)
    }
  }
}
