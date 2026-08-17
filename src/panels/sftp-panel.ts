import * as vscode from 'vscode'
import * as path from 'node:path'
import { homedir } from 'node:os'
import type { SshSessionManager } from '../core/ssh-manager'
import * as sftpManager from '../core/sftp-manager'
import { openRemoteForEdit } from '../services/sftp-edit'

type SftpMessage =
  | { type: 'ready' }
  | { type: 'list'; path: string }
  | { type: 'up' }
  | { type: 'download'; path: string; name: string }
  | { type: 'upload' }
  | { type: 'mkdir'; name: string }
  | { type: 'remove'; path: string; isDirectory: boolean }
  | { type: 'openText'; path: string }
  | { type: 'editText'; path: string }
  | { type: 'rename'; path: string; name: string }

export class SftpPanel {
  public static current: SftpPanel | undefined
  private readonly panel: vscode.WebviewPanel
  private remotePath = '/'
  private disposables: vscode.Disposable[] = []

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly ssh: SshSessionManager,
    private readonly sessionId: string,
    private readonly extensionContext: vscode.ExtensionContext
  ) {
    this.panel = panel
    this.panel.webview.html = this.getHtml()
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(
      (msg: SftpMessage) => void this.onMessage(msg),
      null,
      this.disposables
    )
  }

  static show(
    ssh: SshSessionManager,
    sessionId: string,
    extensionContext: vscode.ExtensionContext
  ): SftpPanel {
    if (SftpPanel.current) {
      SftpPanel.current.panel.reveal()
      return SftpPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      'aiSshPro.sftp',
      'SFTP',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    )
    SftpPanel.current = new SftpPanel(panel, ssh, sessionId, extensionContext)
    void SftpPanel.current.bootstrap()
    return SftpPanel.current
  }

  private async bootstrap(): Promise<void> {
    const client = this.ssh.getClient(this.sessionId)
    if (!client) {
      void vscode.window.showErrorMessage('SSH session not connected')
      return
    }
    try {
      this.remotePath = await sftpManager.home(client)
    } catch {
      this.remotePath = '/'
    }
    await this.refreshList()
  }

  private async refreshList(): Promise<void> {
    const client = this.ssh.getClient(this.sessionId)
    if (!client) return
    try {
      const result = await sftpManager.list(client, this.remotePath)
      this.remotePath = result.path
      await this.panel.webview.postMessage({
        type: 'listed',
        path: result.path,
        entries: result.entries
      })
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
    }
  }

  private async onMessage(msg: SftpMessage): Promise<void> {
    const client = this.ssh.getClient(this.sessionId)
    if (!client) {
      void vscode.window.showErrorMessage('SSH session closed')
      return
    }

    switch (msg.type) {
      case 'ready':
        await this.refreshList()
        break
      case 'list':
        this.remotePath = msg.path
        await this.refreshList()
        break
      case 'up': {
        const parent = this.remotePath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
        this.remotePath = parent
        await this.refreshList()
        break
      }
      case 'mkdir': {
        const name = msg.name?.trim()
        if (!name) return
        await sftpManager.mkdir(client, sftpManager.joinRemotePath(this.remotePath, name))
        await this.refreshList()
        break
      }
      case 'remove':
        await sftpManager.remove(client, msg.path)
        await this.refreshList()
        break
      case 'rename': {
        const newName = msg.name?.trim()
        if (!newName) return
        const parent = msg.path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
        const toPath = sftpManager.joinRemotePath(parent, newName)
        try {
          await sftpManager.rename(client, msg.path, toPath)
          await this.refreshList()
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
        }
        break
      }
      case 'download': {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(homedir(), msg.name))
        })
        if (!uri) return
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Downloading ${msg.name}` },
          async () => {
            await sftpManager.download(client, msg.path, uri.fsPath)
          }
        )
        void vscode.window.showInformationMessage(`Downloaded to ${uri.fsPath}`)
        break
      }
      case 'upload': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true })
        if (!picked?.length) return
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Uploading…' },
          async () => {
            for (const f of picked) {
              const remote = sftpManager.resolveUploadRemotePath(f.fsPath, this.remotePath + '/')
              await sftpManager.upload(client, f.fsPath, remote)
            }
          }
        )
        await this.refreshList()
        break
      }
      case 'openText': {
        try {
          const choice = await vscode.window.showQuickPick(
            [
              { label: 'Edit & save (write back on save)', value: 'edit' as const },
              { label: 'Preview only', value: 'preview' as const }
            ],
            { placeHolder: 'Open remote file' }
          )
          if (!choice) return
          if (choice.value === 'edit') {
            await openRemoteForEdit(
              this.extensionContext,
              this.ssh,
              this.sessionId,
              msg.path
            )
          } else {
            const text = await sftpManager.readText(client, msg.path)
            const doc = await vscode.workspace.openTextDocument({
              content: text.content,
              language: 'plaintext'
            })
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
            if (text.truncated) {
              void vscode.window.showWarningMessage('File truncated for preview')
            }
          }
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
        }
        break
      }
      case 'editText': {
        try {
          await openRemoteForEdit(
            this.extensionContext,
            this.ssh,
            this.sessionId,
            msg.path
          )
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
        }
        break
      }
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 8px; }
  .bar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #path { flex: 1; min-width: 120px; font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: 0.9; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-widget-border); }
  tr:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
  .dir { color: var(--vscode-textLink-foreground); }
  .actions button { margin-right: 4px; padding: 2px 6px; font-size: 11px; }
</style>
</head>
<body>
  <div class="bar">
    <button id="up">Up</button>
    <button id="refresh">Refresh</button>
    <button id="upload">Upload</button>
    <button id="mkdir">New folder</button>
    <span id="path"></span>
  </div>
  <table>
    <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
<script>
  const vscode = acquireVsCodeApi();
  const rows = document.getElementById('rows');
  const pathEl = document.getElementById('path');
  let current = '/';

  function fmtSize(n, isDir) {
    if (isDir) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/1024/1024).toFixed(1) + ' MB';
  }

  function render(entries) {
    rows.innerHTML = '';
    for (const e of entries) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = e.name;
      if (e.isDirectory) name.className = 'dir';
      name.onclick = () => {
        if (e.isDirectory) vscode.postMessage({ type: 'list', path: e.path });
        else vscode.postMessage({ type: 'openText', path: e.path });
      };
      const size = document.createElement('td');
      size.textContent = fmtSize(e.size, e.isDirectory);
      const mod = document.createElement('td');
      mod.textContent = e.modifyTime ? new Date(e.modifyTime).toLocaleString() : '';
      const act = document.createElement('td');
      act.className = 'actions';
      if (!e.isDirectory) {
        const edit = document.createElement('button');
        edit.textContent = 'Edit';
        edit.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'editText', path: e.path }); };
        act.appendChild(edit);
        const dl = document.createElement('button');
        dl.textContent = 'Download';
        dl.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'download', path: e.path, name: e.name }); };
        act.appendChild(dl);
      }
      const ren = document.createElement('button');
      ren.textContent = 'Rename';
      ren.onclick = (ev) => {
        ev.stopPropagation();
        const next = prompt('New name', e.name);
        if (next && next.trim() && next.trim() !== e.name) {
          vscode.postMessage({ type: 'rename', path: e.path, name: next.trim() });
        }
      };
      act.appendChild(ren);
      const rm = document.createElement('button');
      rm.textContent = 'Delete';
      rm.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'remove', path: e.path, isDirectory: e.isDirectory }); };
      act.appendChild(rm);
      tr.appendChild(name); tr.appendChild(size); tr.appendChild(mod); tr.appendChild(act);
      rows.appendChild(tr);
    }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'listed') {
      current = msg.path;
      pathEl.textContent = msg.path;
      render(msg.entries || []);
    }
  });

  document.getElementById('up').onclick = () => vscode.postMessage({ type: 'up' });
  document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'list', path: current });
  document.getElementById('upload').onclick = () => vscode.postMessage({ type: 'upload' });
  document.getElementById('mkdir').onclick = () => {
    const name = prompt('Folder name');
    if (name) vscode.postMessage({ type: 'mkdir', name });
  };
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`
  }

  dispose(): void {
    SftpPanel.current = undefined
    while (this.disposables.length) {
      this.disposables.pop()?.dispose()
    }
  }
}
