import * as vscode from 'vscode'
import type { InventoryStore } from '../core/inventory-store'
import type { HostInventoryIndexEntry } from '../shared/inventory'

export class InventoryTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: HostInventoryIndexEntry) {
    super(entry.title || entry.id, vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'inventoryHost'
    this.iconPath = new vscode.ThemeIcon('database')
    this.description = entry.host ? `${entry.host}${entry.port ? ':' + entry.port : ''}` : entry.id
    this.tooltip = entry.id
  }
}

export class InventoryTreeProvider implements vscode.TreeDataProvider<InventoryTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<InventoryTreeItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(private readonly inventory: InventoryStore) {}

  refresh(): void {
    this._onDidChange.fire(undefined)
  }

  getTreeItem(element: InventoryTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): InventoryTreeItem[] {
    return this.inventory.list().map((e) => new InventoryTreeItem(e))
  }
}
