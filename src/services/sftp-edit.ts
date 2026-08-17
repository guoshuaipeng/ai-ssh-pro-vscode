import * as vscode from 'vscode'
import * as path from 'node:path'
import type { SshSessionManager } from '../core/ssh-manager'
import * as sftpManager from '../core/sftp-manager'

type RemoteEditMeta = {
  sessionId: string
  remotePath: string
}

const META_KEY = 'aiSshPro.sftpEditMap'

/** In-memory document URI → remote edit target (primary tracker). */
const liveEdits = new Map<string, RemoteEditMeta>()

let saveHandlerRegistered = false

function persistEditMap(context: vscode.ExtensionContext): void {
  const obj: Record<string, RemoteEditMeta> = {}
  for (const [k, v] of liveEdits) obj[k] = v
  void context.workspaceState.update(META_KEY, obj)
}

/**
 * Register onDidSaveTextDocument / close handlers once (call from activate).
 */
export function registerSftpEditSupport(
  context: vscode.ExtensionContext,
  ssh: SshSessionManager
): void {
  if (saveHandlerRegistered) return
  saveHandlerRegistered = true

  const stored = context.workspaceState.get<Record<string, RemoteEditMeta>>(META_KEY)
  if (stored) {
    for (const [k, v] of Object.entries(stored)) liveEdits.set(k, v)
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const key = doc.uri.toString()
      const meta = liveEdits.get(key)
      if (!meta) return

      const client = ssh.getClient(meta.sessionId)
      if (!client) {
        void vscode.window.showErrorMessage(
          `Cannot save ${meta.remotePath}: SSH session closed`
        )
        return
      }

      try {
        await sftpManager.writeText(client, meta.remotePath, doc.getText())
        void vscode.window.showInformationMessage(`Saved to ${meta.remotePath}`)
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString()
      if (liveEdits.delete(key)) {
        persistEditMap(context)
      }
    })
  )
}

/**
 * Open a remote file as an untitled document; on save, write back via SFTP.
 */
export async function openRemoteForEdit(
  context: vscode.ExtensionContext,
  ssh: SshSessionManager,
  sessionId: string,
  remotePath: string
): Promise<void> {
  registerSftpEditSupport(context, ssh)

  const client = ssh.getClient(sessionId)
  if (!client) {
    throw new Error('SSH session not connected')
  }

  const text = await sftpManager.readText(client, remotePath)
  if (text.truncated) {
    void vscode.window.showWarningMessage(
      'File truncated for edit — saving may overwrite with truncated content'
    )
  }

  const base = path.posix.basename(remotePath) || 'remote.txt'
  const language = guessLanguage(base)
  const doc = await vscode.workspace.openTextDocument({
    content: text.content,
    language
  })
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)

  const meta: RemoteEditMeta = { sessionId, remotePath: text.path }
  liveEdits.set(doc.uri.toString(), meta)
  persistEditMap(context)

  void vscode.window.showInformationMessage(
    `Editing ${text.path} — save (Ctrl+S) writes back via SFTP`
  )
}

function guessLanguage(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  const map: Record<string, string> = {
    '.js': 'javascript',
    '.ts': 'typescript',
    '.json': 'json',
    '.md': 'markdown',
    '.py': 'python',
    '.sh': 'shellscript',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.xml': 'xml',
    '.html': 'html',
    '.css': 'css',
    '.conf': 'ini',
    '.ini': 'ini',
    '.toml': 'toml',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.sql': 'sql',
    '.log': 'log'
  }
  return map[ext] || 'plaintext'
}
