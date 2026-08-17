import * as vscode from 'vscode'
import type { AppStore } from '../services/app-store'
import type { SshSessionManager } from '../core/ssh-manager'
import type { SavedSessionFolder, SavedSessionProfile } from '../shared/ipc'
import { listActiveSessionIds } from '../services/terminal-bridge'

export type SessionTreeItemData =
  | { type: 'folder'; folder: SavedSessionFolder }
  | { type: 'profile'; profile: SavedSessionProfile }
  | { type: 'active'; sessionId: string; label: string }

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly data: SessionTreeItemData) {
    super(
      data.type === 'folder'
        ? data.folder.name
        : data.type === 'profile'
          ? data.profile.label
          : data.label,
      data.type === 'folder'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    )

    if (data.type === 'folder') {
      this.contextValue = 'folder'
      this.iconPath = new vscode.ThemeIcon('folder')
    } else if (data.type === 'profile') {
      this.contextValue = 'profile'
      this.iconPath = new vscode.ThemeIcon('server')
      this.description = `${data.profile.username}@${data.profile.host}:${data.profile.port}`
      this.command = {
        command: 'aiSshPro.connectProfile',
        title: 'Connect',
        arguments: [this]
      }
    } else {
      this.contextValue = 'activeSession'
      this.iconPath = new vscode.ThemeIcon('terminal')
      this.description = 'connected'
    }
  }
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<SessionTreeItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(
    private readonly store: AppStore,
    private readonly ssh: SshSessionManager
  ) {}

  refresh(): void {
    this._onDidChange.fire(undefined)
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    const state = await this.store.getSavedSessionsState()

    if (!element) {
      const items: SessionTreeItem[] = []

      for (const sessionId of listActiveSessionIds()) {
        const meta = this.ssh.get(sessionId)?.meta
        if (!meta) continue
        items.push(
          new SessionTreeItem({
            type: 'active',
            sessionId,
            label: meta.label || `${meta.username}@${meta.host}`
          })
        )
      }

      for (const folder of state.folders) {
        items.push(new SessionTreeItem({ type: 'folder', folder }))
      }

      for (const profile of state.profiles.filter((p) => !p.folderId)) {
        items.push(new SessionTreeItem({ type: 'profile', profile }))
      }

      return items
    }

    if (element.data.type === 'folder') {
      const folderId = element.data.folder.id
      return state.profiles
        .filter((p) => p.folderId === folderId)
        .map((profile) => new SessionTreeItem({ type: 'profile', profile }))
    }

    return []
  }
}
