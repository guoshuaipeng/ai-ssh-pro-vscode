import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SshSessionManager } from './core/ssh-manager'
import { LocalShellManager, isLocalShellAvailable } from './core/local-shell'
import { setHostKeyPromptHandler } from './core/host-key'
import { getInventoryStore } from './core/inventory-store'
import { importSessionFilesFromPaths } from './core/session-import'
import { exportSessionsToJson, exportSessionsToOpenSsh } from './core/session-export'
import {
  startRecording,
  stopRecording,
  isRecording,
  stopAllRecordings
} from './core/session-recorder'
import * as dockerManager from './core/docker-manager'
import { AppStore } from './services/app-store'
import { promptConnectOptions, promptSaveProfile } from './services/connect-wizard'
import {
  SshPseudoTerminal,
  registerSessionTerminal,
  unregisterSessionTerminal,
  getSessionTerminal,
  findActiveSshSessionId,
  listActiveSessionIds
} from './services/terminal-bridge'
import { SessionsTreeProvider, SessionTreeItem } from './providers/sessions-tree'
import { SnippetsTreeProvider, SnippetTreeItem } from './providers/snippets-tree'
import { InventoryTreeProvider, InventoryTreeItem } from './providers/inventory-tree'
import { DockerTreeProvider, DockerTreeItem } from './providers/docker-tree'
import { SftpPanel } from './panels/sftp-panel'
import { registerSftpEditSupport } from './services/sftp-edit'
import type { SavedSessionProfile, SshConnectOptions } from './shared/ipc'
import { existsSync } from 'node:fs'

let sshManager: SshSessionManager
let localManager: LocalShellManager
let appStore: AppStore

async function openSshTerminal(
  opts: SshConnectOptions,
  profileId?: string
): Promise<string> {
  const pty = new SshPseudoTerminal('ssh', sshManager, localManager)
  const sink = pty.createSink()
  const dims = pty.getDimensions()

  const result = await sshManager.connect(
    { ...opts, termCols: dims.cols, termRows: dims.rows },
    sink,
    { profileId }
  )
  pty.sessionId = result.sessionId

  const terminal = vscode.window.createTerminal({
    name: result.meta.label || `${result.meta.username}@${result.meta.host}`,
    pty
  })
  registerSessionTerminal(result.sessionId, terminal, pty)
  terminal.show()

  const sub = vscode.window.onDidCloseTerminal((t) => {
    if (t === terminal) {
      unregisterSessionTerminal(result.sessionId)
      sub.dispose()
    }
  })

  return result.sessionId
}

export function activate(context: vscode.ExtensionContext): void {
  sshManager = new SshSessionManager()
  localManager = new LocalShellManager()
  appStore = new AppStore(context.secrets)

  const inventoryRoot = vscode.workspace.getConfiguration('aiSshPro').get<string>('inventoryRoot')
  const inventory = getInventoryStore(inventoryRoot || null)

  setHostKeyPromptHandler(async (req) => {
    const title =
      req.reason === 'changed'
        ? `Host key CHANGED for ${req.host}:${req.port}`
        : `Unknown host key for ${req.host}:${req.port}`
    const detail =
      req.reason === 'changed'
        ? `Previous: ${req.previousFingerprint}\nNew: ${req.fingerprint}`
        : `Fingerprint: ${req.fingerprint}`

    const pick = await vscode.window.showWarningMessage(
      `${title}\n${detail}`,
      { modal: true },
      'Trust once',
      'Always trust',
      'Reject'
    )
    if (pick === 'Always trust') return { accept: true, alwaysTrust: true }
    if (pick === 'Trust once') return { accept: true, alwaysTrust: false }
    return { accept: false, alwaysTrust: false }
  })

  const sessionsTree = new SessionsTreeProvider(appStore, sshManager)
  const snippetsTree = new SnippetsTreeProvider(appStore)
  const inventoryTree = new InventoryTreeProvider(inventory)
  const dockerTree = new DockerTreeProvider(sshManager)

  registerSftpEditSupport(context, sshManager)

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiSshPro.sessions', sessionsTree),
    vscode.window.registerTreeDataProvider('aiSshPro.snippets', snippetsTree),
    vscode.window.registerTreeDataProvider('aiSshPro.inventory', inventoryTree),
    vscode.window.registerTreeDataProvider('aiSshPro.docker', dockerTree)
  )

  const refreshAll = () => {
    sessionsTree.refresh()
    snippetsTree.refresh()
    inventoryTree.refresh()
    dockerTree.refresh()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.refreshSessions', () => sessionsTree.refresh()),
    vscode.commands.registerCommand('aiSshPro.refreshDocker', () => dockerTree.refresh()),
    vscode.commands.registerCommand('aiSshPro.refreshInventory', () => inventoryTree.refresh())
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.connect', async () => {
      try {
        const opts = await promptConnectOptions()
        if (!opts) return
        await openSshTerminal(opts)
        sessionsTree.refresh()
        dockerTree.refresh()

        const save = await vscode.window.showInformationMessage('Save this session?', 'Save', 'Skip')
        if (save === 'Save') {
          const profile = await promptSaveProfile(opts)
          const folderPick = await pickFolderOptional()
          if (folderPick) profile.folderId = folderPick
          await appStore.upsertProfile(profile)
          sessionsTree.refresh()
        }
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.connectProfile', async (item?: SessionTreeItem) => {
      try {
        let profile: SavedSessionProfile | undefined
        if (item?.data.type === 'profile') {
          profile = item.data.profile
        } else {
          const state = await appStore.getSavedSessionsState()
          const pick = await vscode.window.showQuickPick(
            state.profiles.map((p) => ({
              label: p.label,
              description: `${p.username}@${p.host}:${p.port}`,
              profile: p
            })),
            { placeHolder: 'Select session' }
          )
          profile = pick?.profile
        }
        if (!profile) return
        const opts: SshConnectOptions = {
          host: profile.host,
          port: profile.port,
          username: profile.username,
          password: profile.password,
          privateKeyPath: profile.privateKeyPath,
          passphrase: profile.passphrase,
          label: profile.label,
          jumpHost: profile.jumpHost,
          forwards: profile.forwards
        }
        await openSshTerminal(opts, profile.id)
        sessionsTree.refresh()
        dockerTree.refresh()
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.disconnect', async (item?: SessionTreeItem) => {
      const sessionId =
        item?.data.type === 'active'
          ? item.data.sessionId
          : findActiveSshSessionId(sshManager)
      if (!sessionId) {
        void vscode.window.showWarningMessage('No active session')
        return
      }
      const term = getSessionTerminal(sessionId)
      sshManager.disconnect(sessionId)
      term?.terminal.dispose()
      unregisterSessionTerminal(sessionId)
      sessionsTree.refresh()
      dockerTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.reconnect', async (item?: SessionTreeItem) => {
      const sessionId =
        item?.data.type === 'active'
          ? item.data.sessionId
          : findActiveSshSessionId(sshManager)
      if (!sessionId) return
      const managed = sshManager.get(sessionId)
      if (!managed) return
      const opts = { ...managed.connectOpts }
      const profileId = managed.profileId
      sshManager.disconnect(sessionId)
      getSessionTerminal(sessionId)?.terminal.dispose()
      unregisterSessionTerminal(sessionId)
      try {
        await openSshTerminal(opts, profileId)
        sessionsTree.refresh()
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.openSftp', async (item?: SessionTreeItem) => {
      const sessionId =
        item?.data.type === 'active'
          ? item.data.sessionId
          : findActiveSshSessionId(sshManager)
      if (!sessionId) {
        void vscode.window.showWarningMessage('Connect an SSH session first')
        return
      }
      SftpPanel.show(sshManager, sessionId, context)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.openLocalShell', async () => {
      try {
        if (!isLocalShellAvailable()) {
          const open = await vscode.window.showWarningMessage(
            'node-pty is not available. Open a normal VS Code terminal instead?',
            'Open Terminal',
            'Cancel'
          )
          if (open === 'Open Terminal') {
            const t = vscode.window.createTerminal('Local Shell')
            t.show()
          }
          return
        }
        const pty = new SshPseudoTerminal('local', sshManager, localManager)
        const sink = pty.createSink()
        const dims = pty.getDimensions()
        const result = localManager.open(sink, dims.cols, dims.rows)
        pty.sessionId = result.sessionId
        const terminal = vscode.window.createTerminal({ name: '本机 Shell', pty })
        registerSessionTerminal(result.sessionId, terminal, pty)
        terminal.show()
        sessionsTree.refresh()
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.newFolder', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Folder name', ignoreFocusOut: true })
      if (!name?.trim()) return
      await appStore.addFolder(name.trim())
      sessionsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.deleteFolder', async (item?: SessionTreeItem) => {
      if (item?.data.type !== 'folder') return
      const ok = await vscode.window.showWarningMessage(
        `Delete folder "${item.data.folder.name}"? Profiles move to root.`,
        { modal: true },
        'Delete'
      )
      if (ok !== 'Delete') return
      await appStore.deleteFolder(item.data.folder.id)
      sessionsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.editProfile', async (item?: SessionTreeItem) => {
      if (item?.data.type !== 'profile') return
      const opts = await promptConnectOptions(item.data.profile)
      if (!opts) return
      const profile = await promptSaveProfile(opts, item.data.profile.id)
      profile.folderId = item.data.profile.folderId
      profile.hostInventoryId = item.data.profile.hostInventoryId
      await appStore.upsertProfile(profile)
      sessionsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.deleteProfile', async (item?: SessionTreeItem) => {
      if (item?.data.type !== 'profile') return
      const ok = await vscode.window.showWarningMessage(
        `Delete profile "${item.data.profile.label}"?`,
        { modal: true },
        'Delete'
      )
      if (ok !== 'Delete') return
      await appStore.deleteProfile(item.data.profile.id)
      sessionsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.saveSession', async () => {
      const sessionId = findActiveSshSessionId(sshManager)
      const managed = sessionId ? sshManager.get(sessionId) : undefined
      if (!managed) {
        void vscode.window.showWarningMessage('No active SSH session')
        return
      }
      const profile = await promptSaveProfile(managed.connectOpts, managed.profileId)
      await appStore.upsertProfile(profile)
      sessionsTree.refresh()
      void vscode.window.showInformationMessage('Session saved')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.importSessions', async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: {
          Sessions: ['json', 'xsh', 'conf', 'config', 'reg', 'txt'],
          All: ['*']
        }
      })
      if (!files?.length) return
      const result = await importSessionFilesFromPaths(files.map((f) => f.fsPath))
      if (!result.items.length) {
        void vscode.window.showWarningMessage(
          result.notes.join('\n') || 'No sessions imported'
        )
        return
      }
      const state = await appStore.getSavedSessionsState()
      for (const draft of result.items) {
        state.profiles.push({
          id: randomUUID(),
          label: draft.label,
          host: draft.host,
          port: draft.port,
          username: draft.username,
          password: draft.password,
          privateKeyPath: draft.privateKeyPath,
          passphrase: draft.passphrase,
          jumpHost: draft.jumpHost,
          forwards: draft.forwards
        })
      }
      await appStore.setSavedSessionsState(state)
      sessionsTree.refresh()
      const note = result.notes.length ? `\n${result.notes.join('\n')}` : ''
      void vscode.window.showInformationMessage(`Imported ${result.items.length} session(s).${note}`)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.exportJson', async () => {
      const state = await appStore.getSavedSessionsState()
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(join(homedir(), 'ai-ssh-pro-sessions.json')),
        filters: { JSON: ['json'] }
      })
      if (!uri) return
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(exportSessionsToJson(state), 'utf8')
      )
      void vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.exportOpenSsh', async () => {
      const state = await appStore.getSavedSessionsState()
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(join(homedir(), 'config.aissh')),
        filters: { Config: ['*'] }
      })
      if (!uri) return
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(exportSessionsToOpenSsh(state), 'utf8')
      )
      void vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.toggleRecording', async (item?: SessionTreeItem) => {
      const sessionId =
        item?.data.type === 'active'
          ? item.data.sessionId
          : findActiveSshSessionId(sshManager)
      if (!sessionId || !sshManager.get(sessionId)) {
        void vscode.window.showWarningMessage('No active SSH session')
        return
      }
      if (isRecording(sessionId)) {
        stopRecording(sessionId)
        void vscode.window.showInformationMessage('Recording stopped')
        return
      }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          join(homedir(), `ssh-record-${sessionId.slice(0, 8)}.log`)
        )
      })
      if (!uri) return
      startRecording(sessionId, uri.fsPath)
      void vscode.window.showInformationMessage(`Recording to ${uri.fsPath}`)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.terminalPrefs', async () => {
      const prefs = appStore.getTerminalPrefs()
      const theme = await vscode.window.showQuickPick(
        [
          { label: 'github-dark', description: prefs.themeId === 'github-dark' ? 'current' : '' },
          { label: 'solarized-dark', description: prefs.themeId === 'solarized-dark' ? 'current' : '' },
          { label: 'monokai', description: prefs.themeId === 'monokai' ? 'current' : '' }
        ],
        { placeHolder: 'Terminal theme (stored; VS Code terminal uses workbench theme)' }
      )
      if (!theme) return
      const fontSizeStr = await vscode.window.showInputBox({
        prompt: 'Font size',
        value: String(prefs.fontSize)
      })
      if (fontSizeStr === undefined) return
      const scrollbackStr = await vscode.window.showInputBox({
        prompt: 'Scrollback lines',
        value: String(prefs.scrollback)
      })
      if (scrollbackStr === undefined) return
      appStore.setTerminalPrefs({
        themeId: theme.label as 'github-dark' | 'solarized-dark' | 'monokai',
        fontSize: Math.floor(Number(fontSizeStr)) || prefs.fontSize,
        scrollback: Math.floor(Number(scrollbackStr)) || prefs.scrollback
      })
      void vscode.window.showInformationMessage('Terminal preferences saved')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.addSnippet', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Snippet title', ignoreFocusOut: true })
      if (!title?.trim()) return
      const body = await vscode.window.showInputBox({
        prompt: 'Command body',
        ignoreFocusOut: true,
        placeHolder: 'e.g. systemctl status nginx'
      })
      if (body === undefined) return
      const list = appStore.getSnippets()
      list.push({ id: randomUUID(), title: title.trim(), body })
      appStore.setSnippets(list)
      snippetsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.runSnippet', async (item?: SnippetTreeItem) => {
      const snippet = item?.snippet
      if (!snippet) return
      const sessionId = findActiveSshSessionId(sshManager)
      if (!sessionId) {
        void vscode.window.showWarningMessage('Connect an SSH session first')
        return
      }
      const data = snippet.body.endsWith('\n') ? snippet.body : `${snippet.body}\n`
      sshManager.write(sessionId, data)
      getSessionTerminal(sessionId)?.terminal.show()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.deleteSnippet', async (item?: SnippetTreeItem) => {
      if (!item) return
      const list = appStore.getSnippets().filter((s) => s.id !== item.snippet.id)
      appStore.setSnippets(list)
      snippetsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.dockerExec', async (item?: DockerTreeItem) => {
      if (item?.node.kind !== 'container') return
      try {
        const pty = new SshPseudoTerminal('ssh', sshManager, localManager)
        const sink = pty.createSink()
        const dims = pty.getDimensions()
        const result = await sshManager.openDockerExec(
          item.node.sessionId,
          item.node.container.id,
          sink,
          {
            termCols: dims.cols,
            termRows: dims.rows,
            label: `docker:${item.node.container.name}`
          }
        )
        pty.sessionId = result.sessionId
        const terminal = vscode.window.createTerminal({ name: result.meta.label || 'docker exec', pty })
        registerSessionTerminal(result.sessionId, terminal, pty)
        terminal.show()
        sessionsTree.refresh()
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.dockerAction', async (item?: DockerTreeItem) => {
      if (item?.node.kind !== 'container') return
      const action = await vscode.window.showQuickPick(
        [
          { label: 'start', value: 'start' as const },
          { label: 'stop', value: 'stop' as const },
          { label: 'restart', value: 'restart' as const },
          { label: 'rm', value: 'rm' as const }
        ],
        { placeHolder: 'Container action' }
      )
      if (!action) return
      const client = sshManager.getClient(item.node.sessionId)
      if (!client) return
      try {
        await dockerManager.containerAction(client, item.node.container.id, action.value)
        dockerTree.refresh()
        void vscode.window.showInformationMessage(`${action.label} OK`)
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.upsertInventoryHost', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Host title', ignoreFocusOut: true })
      if (!title?.trim()) return
      const host = await vscode.window.showInputBox({ prompt: 'Hostname / IP', ignoreFocusOut: true })
      if (host === undefined) return
      const portStr = await vscode.window.showInputBox({ prompt: 'Port', value: '22' })
      if (portStr === undefined) return
      const username = await vscode.window.showInputBox({ prompt: 'Username', ignoreFocusOut: true })
      if (username === undefined) return
      inventory.upsert({
        title: title.trim(),
        host: host.trim() || undefined,
        port: Math.floor(Number(portStr)) || 22,
        username: username.trim() || undefined
      })
      inventoryTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.appendInventoryNote', async (item?: InventoryTreeItem) => {
      if (!item) return
      const note = await vscode.window.showInputBox({
        prompt: 'Note to append',
        ignoreFocusOut: true
      })
      if (!note?.trim()) return
      inventory.appendNote(item.entry.id, note.trim())
      inventoryTree.refresh()
      void vscode.window.showInformationMessage('Note appended')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.linkInventory', async () => {
      const state = await appStore.getSavedSessionsState()
      const profilePick = await vscode.window.showQuickPick(
        state.profiles.map((p) => ({ label: p.label, description: p.id, profile: p })),
        { placeHolder: 'Select session profile' }
      )
      if (!profilePick) return
      const hosts = inventory.list()
      const hostPick = await vscode.window.showQuickPick(
        hosts.map((h) => ({ label: h.title, description: h.id, entry: h })),
        { placeHolder: 'Select inventory host' }
      )
      if (!hostPick) return
      profilePick.profile.hostInventoryId = hostPick.entry.id
      await appStore.upsertProfile(profilePick.profile)
      inventory.upsert({
        id: hostPick.entry.id,
        title: hostPick.entry.title,
        host: hostPick.entry.host,
        port: hostPick.entry.port,
        username: hostPick.entry.username,
        profileId: profilePick.profile.id,
        tags: hostPick.entry.tags
      })
      refreshAll()
      void vscode.window.showInformationMessage('Linked inventory to profile')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.moveProfile', async (item?: SessionTreeItem) => {
      if (item?.data.type !== 'profile') return
      const state = await appStore.getSavedSessionsState()
      const pick = await vscode.window.showQuickPick(
        [
          { label: '(root)', id: undefined as string | undefined },
          ...state.folders.map((f) => ({ label: f.name, id: f.id as string | undefined }))
        ],
        { placeHolder: 'Move to folder' }
      )
      if (!pick) return
      const profile = { ...item.data.profile }
      if (pick.id) profile.folderId = pick.id
      else delete profile.folderId
      await appStore.upsertProfile(profile)
      sessionsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.broadcast', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Broadcast to all active SSH sessions (adds Enter)',
        ignoreFocusOut: true
      })
      if (text === undefined) return
      const payload = text.endsWith('\n') ? text : `${text}\n`
      let n = 0
      for (const id of listActiveSessionIds()) {
        if (!sshManager.get(id)) continue
        if (sshManager.write(id, payload)) n += 1
      }
      void vscode.window.showInformationMessage(`Broadcast to ${n} session(s)`)
    })
  )

  const dockerOut = vscode.window.createOutputChannel('AI-SSH-Pro Docker')
  context.subscriptions.push(dockerOut)

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.dockerLogs', async (item?: DockerTreeItem) => {
      if (item?.node.kind !== 'container') return
      const client = sshManager.getClient(item.node.sessionId)
      if (!client) return
      try {
        const logs = await dockerManager.containerLogs(client, item.node.container.id, 200)
        const text = typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2)
        dockerOut.clear()
        dockerOut.appendLine(`=== logs: ${item.node.container.name} ===`)
        dockerOut.appendLine(text)
        dockerOut.show(true)
        const doc = await vscode.workspace.openTextDocument({
          content: text,
          language: 'log'
        })
        await vscode.window.showTextDocument(doc, { preview: false })
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.dockerInspect', async (item?: DockerTreeItem) => {
      if (item?.node.kind !== 'container') return
      const client = sshManager.getClient(item.node.sessionId)
      if (!client) return
      try {
        const detail = await dockerManager.inspectContainer(client, item.node.container.id)
        const doc = await vscode.workspace.openTextDocument({
          content: JSON.stringify(detail, null, 2),
          language: 'json'
        })
        await vscode.window.showTextDocument(doc, { preview: false })
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.dockerComposeAction', async (item?: DockerTreeItem) => {
      if (item?.node.kind !== 'compose') return
      const action = await vscode.window.showQuickPick(
        [
          { label: 'up', value: 'up' as const },
          { label: 'down', value: 'down' as const }
        ],
        { placeHolder: `Compose action for ${item.node.name}` }
      )
      if (!action) return
      const client = sshManager.getClient(item.node.sessionId)
      if (!client) return
      try {
        await dockerManager.composeAction(client, item.node.name, action.value)
        dockerTree.refresh()
        void vscode.window.showInformationMessage(`compose ${action.label} OK`)
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.dockerSwarmAction', async (item?: DockerTreeItem) => {
      if (item?.node.kind !== 'swarmStack') return
      const services = item.node.children
        .map((c) => c.container.swarmService || c.container.name)
        .filter(Boolean)
      const unique = [...new Set(services)]
      const svc = await vscode.window.showQuickPick(
        unique.map((s) => ({ label: s })),
        { placeHolder: `Swarm service in ${item.node.name || '(stack)'}` }
      )
      if (!svc) return
      const action = await vscode.window.showQuickPick(
        [
          { label: 'restart (force update)', value: 'restart' as const },
          { label: 'scale', value: 'scale' as const }
        ],
        { placeHolder: `Action for ${svc.label}` }
      )
      if (!action) return
      let replicas: number | undefined
      if (action.value === 'scale') {
        const n = await vscode.window.showInputBox({ prompt: 'Replicas', value: '1' })
        if (n === undefined) return
        replicas = Math.max(0, Math.floor(Number(n)) || 0)
      }
      const client = sshManager.getClient(item.node.sessionId)
      if (!client) return
      try {
        await dockerManager.swarmServiceAction(client, svc.label, action.value, replicas)
        dockerTree.refresh()
        void vscode.window.showInformationMessage(`swarm ${action.label} OK`)
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.addInventoryService', async (item?: InventoryTreeItem) => {
      if (!item) return
      const name = await vscode.window.showInputBox({ prompt: 'Service name', ignoreFocusOut: true })
      if (!name?.trim()) return
      const kindPick = await vscode.window.showQuickPick(
        [
          { label: 'systemd', value: 'systemd' as const },
          { label: 'docker', value: 'docker' as const },
          { label: 'k8s', value: 'k8s' as const },
          { label: 'binary', value: 'binary' as const },
          { label: 'unknown', value: 'unknown' as const }
        ],
        { placeHolder: 'Service kind' }
      )
      if (!kindPick) return
      const portsRaw = await vscode.window.showInputBox({
        prompt: 'Ports (comma-separated, optional)',
        placeHolder: '80,443'
      })
      if (portsRaw === undefined) return
      const ports = portsRaw
        .split(/[\s,]+/)
        .map((p) => Math.floor(Number(p)))
        .filter((p) => p > 0 && p < 65536)
      const notes = await vscode.window.showInputBox({ prompt: 'Notes (optional)' })
      if (notes === undefined) return
      inventory.upsertService(item.entry.id, {
        name: name.trim(),
        kind: kindPick.value,
        ...(ports.length ? { ports } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {})
      })
      inventoryTree.refresh()
      void vscode.window.showInformationMessage('Service saved')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.copyTerminalSnapshot', async () => {
      const sessionId = findActiveSshSessionId(sshManager)
      if (!sessionId) {
        void vscode.window.showWarningMessage('No active SSH session')
        return
      }
      const snap = sshManager.getRingSnapshot(sessionId, 200)
      if (!snap?.trim()) {
        void vscode.window.showWarningMessage('No terminal output captured yet')
        return
      }
      await vscode.env.clipboard.writeText(snap)
      void vscode.window.showInformationMessage('Terminal snapshot copied')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.openInventoryHost', async (item?: InventoryTreeItem) => {
      if (!item) return
      const rec = inventory.get(item.entry.id)
      if (!rec) {
        void vscode.window.showWarningMessage('Host not found')
        return
      }
      const body = [
        `# ${rec.meta.title}`,
        '',
        `- id: ${rec.meta.id}`,
        `- host: ${rec.meta.host || ''}`,
        `- port: ${rec.meta.port ?? 22}`,
        `- username: ${rec.meta.username || ''}`,
        `- tags: ${(rec.meta.tags || []).join(', ')}`,
        '',
        '## Services',
        ...rec.services.map(
          (s) => `- ${s.name} (${s.kind})${s.ports?.length ? ` ports=${s.ports.join(',')}` : ''}`
        ),
        '',
        '## Notes',
        rec.notesMarkdown || '_empty_'
      ].join('\n')
      const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' })
      await vscode.window.showTextDocument(doc, { preview: false })
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.deleteInventoryHost', async (item?: InventoryTreeItem) => {
      if (!item) return
      const ok = await vscode.window.showWarningMessage(
        `Delete inventory host "${item.entry.title}"?`,
        { modal: true },
        'Delete'
      )
      if (ok !== 'Delete') return
      inventory.remove(item.entry.id)
      inventoryTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.searchInventory', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Search inventory', ignoreFocusOut: true })
      if (query === undefined) return
      const hits = inventory.search(query)
      const pick = await vscode.window.showQuickPick(
        hits.map((h) => ({ label: h.title, description: h.host || h.id, entry: h })),
        { placeHolder: `${hits.length} result(s)` }
      )
      if (!pick) return
      await vscode.commands.executeCommand(
        'aiSshPro.openInventoryHost',
        new InventoryTreeItem(pick.entry)
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.editSnippet', async (item?: SnippetTreeItem) => {
      if (!item) return
      const title = await vscode.window.showInputBox({
        prompt: 'Snippet title',
        value: item.snippet.title,
        ignoreFocusOut: true
      })
      if (!title?.trim()) return
      const body = await vscode.window.showInputBox({
        prompt: 'Command body',
        value: item.snippet.body,
        ignoreFocusOut: true
      })
      if (body === undefined) return
      const list = appStore.getSnippets().map((s) =>
        s.id === item.snippet.id ? { ...s, title: title.trim(), body } : s
      )
      appStore.setSnippets(list)
      snippetsTree.refresh()
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('aiSshPro.showMcpGuide', async () => {
      const scriptCandidates = [
        join(context.extensionPath, 'scripts', 'mcp-inventory-server.mjs'),
        join(context.extensionPath, 'out', '..', 'scripts', 'mcp-inventory-server.mjs')
      ]
      const scriptPath = scriptCandidates.find((p) => existsSync(p)) || scriptCandidates[0]!
      const invRoot = inventory.root
      const jsonPath = scriptPath.replace(/\\/g, '/')
      const invJson = invRoot.replace(/\\/g, '/')
      const sample = `{
  "mcpServers": {
    "ai-ssh-inventory": {
      "command": "node",
      "args": ["${jsonPath}"],
      "env": {
        "AISS_INVENTORY_ROOT": "${invJson}"
      }
    }
  }
}`
      const open = await vscode.window.showInformationMessage(
        `MCP script: ${scriptPath}\nInventory: ${invRoot}`,
        'Open guide'
      )
      if (open !== 'Open guide') return
      const doc = await vscode.workspace.openTextDocument({
        content: [
          '# AI-SSH-Pro MCP Inventory Guide',
          '',
          'Share the same host inventory files with Cursor / Claude Desktop.',
          '',
          `## Script`,
          '',
          '`' + scriptPath + '`',
          '',
          `## Inventory root`,
          '',
          '`' + invRoot + '`',
          '',
          '## Example Cursor MCP config',
          '',
          '```json',
          sample,
          '```',
          '',
          'Run locally: `npm run mcp:inventory` from the extension repo.'
        ].join('\n'),
        language: 'markdown'
      })
      await vscode.window.showTextDocument(doc, { preview: false })
    })
  )

  async function pickFolderOptional(): Promise<string | undefined> {
    const state = await appStore.getSavedSessionsState()
    if (!state.folders.length) return undefined
    const pick = await vscode.window.showQuickPick(
      [
        { label: '(root)', id: undefined as string | undefined },
        ...state.folders.map((f) => ({ label: f.name, id: f.id as string | undefined }))
      ],
      { placeHolder: 'Folder (optional)' }
    )
    return pick?.id
  }

  context.subscriptions.push({
    dispose: () => {
      setHostKeyPromptHandler(null)
      stopAllRecordings()
      sshManager.disconnectAll()
      localManager.disconnectAll()
    }
  })
}

export function deactivate(): void {
  stopAllRecordings()
  sshManager?.disconnectAll()
  localManager?.disconnectAll()
}
