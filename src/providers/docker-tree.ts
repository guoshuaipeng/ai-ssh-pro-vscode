import * as vscode from 'vscode'
import type { SshSessionManager } from '../core/ssh-manager'
import * as dockerManager from '../core/docker-manager'
import type { DockerContainer } from '../shared/ipc'
import { findActiveSshSessionId } from '../services/terminal-bridge'

export type DockerContainerNode = {
  kind: 'container'
  sessionId: string
  container: DockerContainer
}

export type DockerTreeNode =
  | { kind: 'rootMsg'; label: string }
  | {
      kind: 'compose'
      sessionId: string
      name: string
      children: DockerContainerNode[]
    }
  | {
      kind: 'swarmStack'
      sessionId: string
      name: string
      children: DockerContainerNode[]
    }
  | DockerContainerNode
  | {
      kind: 'group'
      label: string
      children: DockerContainerNode[]
    }

export class DockerTreeItem extends vscode.TreeItem {
  constructor(public readonly node: DockerTreeNode) {
    super(
      node.kind === 'container'
        ? node.container.name
        : node.kind === 'compose'
          ? `compose: ${node.name}`
          : node.kind === 'swarmStack'
            ? `swarm: ${node.name || '(no stack)'}`
            : node.kind === 'group'
              ? node.label
              : node.label,
      node.kind === 'container' || node.kind === 'rootMsg'
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded
    )

    if (node.kind === 'container') {
      this.contextValue = 'dockerContainer'
      this.iconPath = new vscode.ThemeIcon(
        node.container.state === 'running' ? 'vm-running' : 'vm'
      )
      this.description = node.container.shortStatus || node.container.state
      this.tooltip = `${node.container.image}\n${node.container.id}`
    } else if (node.kind === 'compose') {
      this.iconPath = new vscode.ThemeIcon('layers')
      this.contextValue = 'dockerCompose'
    } else if (node.kind === 'swarmStack') {
      this.iconPath = new vscode.ThemeIcon('server-process')
      this.contextValue = 'dockerSwarm'
    } else if (node.kind === 'group') {
      this.iconPath = new vscode.ThemeIcon('folder')
      this.contextValue = 'dockerGroup'
    } else {
      this.iconPath = new vscode.ThemeIcon('info')
    }
  }
}

export class DockerTreeProvider implements vscode.TreeDataProvider<DockerTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<DockerTreeItem | undefined | null>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private cache: DockerTreeNode[] = []

  constructor(private readonly ssh: SshSessionManager) {}

  refresh(): void {
    void this.reload().then(() => this._onDidChange.fire(undefined))
  }

  getTreeItem(element: DockerTreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: DockerTreeItem): Promise<DockerTreeItem[]> {
    if (!element) {
      if (this.cache.length === 0) {
        await this.reload()
      }
      return this.cache.map((n) => new DockerTreeItem(n))
    }

    if (
      element.node.kind === 'group' ||
      element.node.kind === 'compose' ||
      element.node.kind === 'swarmStack'
    ) {
      return element.node.children.map((n) => new DockerTreeItem(n))
    }
    return []
  }

  private async reload(): Promise<void> {
    const sessionId = findActiveSshSessionId(this.ssh)
    if (!sessionId) {
      this.cache = [{ kind: 'rootMsg', label: 'Connect an SSH session first' }]
      return
    }
    const client = this.ssh.getClient(sessionId)
    if (!client) {
      this.cache = [{ kind: 'rootMsg', label: 'No SSH client' }]
      return
    }

    try {
      const tree = await dockerManager.listTree(client)
      const nodes: DockerTreeNode[] = []

      if (tree.containersError) {
        nodes.push({ kind: 'rootMsg', label: `Containers: ${tree.containersError}` })
      }

      for (const project of tree.composeProjects) {
        nodes.push({
          kind: 'compose',
          sessionId,
          name: project.name,
          children: project.containers.map((c) => ({
            kind: 'container' as const,
            sessionId,
            container: c
          }))
        })
      }

      if (tree.swarm.active) {
        for (const stack of tree.swarm.stacks) {
          const children: DockerContainerNode[] = []
          for (const svc of stack.services) {
            for (const c of svc.containers) {
              children.push({ kind: 'container', sessionId, container: c })
            }
          }
          nodes.push({
            kind: 'swarmStack',
            sessionId,
            name: stack.name,
            children
          })
        }
      }

      if (tree.containers.length) {
        nodes.push({
          kind: 'group',
          label: 'Containers',
          children: tree.containers.map((c) => ({
            kind: 'container' as const,
            sessionId,
            container: c
          }))
        })
      }

      this.cache = nodes.length ? nodes : [{ kind: 'rootMsg', label: 'No Docker resources found' }]
    } catch (e) {
      this.cache = [
        {
          kind: 'rootMsg',
          label: e instanceof Error ? e.message : String(e)
        }
      ]
    }
  }
}
