import * as vscode from 'vscode'
import type { SessionEventSink } from '../core/session-events'
import type { SshSessionManager } from '../core/ssh-manager'
import type { LocalShellManager } from '../core/local-shell'

/**
 * Bridges VS Code Pseudoterminal <-> SSH / local shell session.
 */
export class SshPseudoTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>()
  private readonly closeEmitter = new vscode.EventEmitter<number | void>()
  private alive = true
  private dims: { cols: number; rows: number } = { cols: 120, rows: 32 }

  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event
  readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event

  sessionId: string | null = null

  constructor(
    private readonly kind: 'ssh' | 'local',
    private readonly ssh: SshSessionManager,
    private readonly local: LocalShellManager
  ) {}

  createSink(): SessionEventSink {
    return {
      isAlive: () => this.alive,
      sendData: (_sessionId, chunk) => {
        const text =
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        this.writeEmitter.fire(text)
      },
      sendStatus: (_sessionId, status, message) => {
        if (status === 'closed' || status === 'error') {
          if (message) this.writeEmitter.fire(`\r\n[${message}]\r\n`)
          this.closeEmitter.fire(status === 'error' ? 1 : 0)
        }
      }
    }
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.dims = { cols: initialDimensions.columns, rows: initialDimensions.rows }
    }
  }

  close(): void {
    this.alive = false
    if (!this.sessionId) return
    if (this.kind === 'local' || this.sessionId.startsWith('local:')) {
      this.local.disconnect(this.sessionId)
    } else {
      this.ssh.disconnect(this.sessionId)
    }
    this.sessionId = null
  }

  handleInput(data: string): void {
    if (!this.sessionId) return
    if (this.kind === 'local' || this.sessionId.startsWith('local:')) {
      this.local.write(this.sessionId, data)
    } else {
      this.ssh.write(this.sessionId, data)
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dims = { cols: dimensions.columns, rows: dimensions.rows }
    if (!this.sessionId) return
    if (this.kind === 'local' || this.sessionId.startsWith('local:')) {
      this.local.resize(this.sessionId, dimensions.columns, dimensions.rows)
    } else {
      this.ssh.resize(this.sessionId, dimensions.columns, dimensions.rows)
    }
  }

  getDimensions(): { cols: number; rows: number } {
    return this.dims
  }
}

const sessionTerminals = new Map<string, { terminal: vscode.Terminal; pty: SshPseudoTerminal }>()

export function getSessionTerminal(sessionId: string) {
  return sessionTerminals.get(sessionId)
}

export function registerSessionTerminal(
  sessionId: string,
  terminal: vscode.Terminal,
  pty: SshPseudoTerminal
): void {
  sessionTerminals.set(sessionId, { terminal, pty })
}

export function unregisterSessionTerminal(sessionId: string): void {
  sessionTerminals.delete(sessionId)
}

export function listActiveSessionIds(): string[] {
  return [...sessionTerminals.keys()]
}

export function findActiveSshSessionId(ssh: SshSessionManager): string | undefined {
  for (const id of sessionTerminals.keys()) {
    if (ssh.get(id)) return id
  }
  return undefined
}
