import * as vscode from 'vscode'
import type { AppStore } from '../services/app-store'
import type { CommandSnippet } from '../shared/ipc'

export class SnippetTreeItem extends vscode.TreeItem {
  constructor(public readonly snippet: CommandSnippet) {
    super(snippet.title, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'snippet'
    this.iconPath = new vscode.ThemeIcon('symbol-snippet')
    this.tooltip = snippet.body
    this.description = snippet.body.split('\n')[0]?.slice(0, 40)
    this.command = {
      command: 'aiSshPro.runSnippet',
      title: 'Run',
      arguments: [this]
    }
  }
}

export class SnippetsTreeProvider implements vscode.TreeDataProvider<SnippetTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<SnippetTreeItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(private readonly store: AppStore) {}

  refresh(): void {
    this._onDidChange.fire(undefined)
  }

  getTreeItem(element: SnippetTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): SnippetTreeItem[] {
    return this.store.getSnippets().map((s) => new SnippetTreeItem(s))
  }
}
