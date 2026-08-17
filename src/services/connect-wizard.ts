import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import type { LocalPortForward, SavedSessionProfile, SshConnectOptions, SshJumpHostOptions } from '../shared/ipc'

async function input(prompt: string, value?: string, password = false): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    password,
    ignoreFocusOut: true
  })
}

export async function promptConnectOptions(
  defaults?: Partial<SavedSessionProfile>
): Promise<SshConnectOptions | undefined> {
  const host = await input('Host', defaults?.host)
  if (host === undefined) return undefined
  if (!host.trim()) {
    void vscode.window.showErrorMessage('Host is required')
    return undefined
  }

  const portStr = await input('Port', String(defaults?.port ?? 22))
  if (portStr === undefined) return undefined
  const port = Math.floor(Number(portStr)) || 22

  const username = await input('Username', defaults?.username)
  if (username === undefined) return undefined
  if (!username.trim()) {
    void vscode.window.showErrorMessage('Username is required')
    return undefined
  }

  const auth = await vscode.window.showQuickPick(
    [
      { label: 'Password', value: 'password' as const },
      { label: 'Private key', value: 'key' as const },
      { label: 'Default ~/.ssh key (no password)', value: 'default' as const }
    ],
    { placeHolder: 'Authentication', ignoreFocusOut: true }
  )
  if (!auth) return undefined

  let password: string | undefined
  let privateKeyPath: string | undefined
  let passphrase: string | undefined

  if (auth.value === 'password') {
    password = await input('Password', defaults?.password, true)
    if (password === undefined) return undefined
  } else if (auth.value === 'key') {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select private key',
      defaultUri: defaults?.privateKeyPath ? vscode.Uri.file(defaults.privateKeyPath) : undefined
    })
    if (picked?.[0]) {
      privateKeyPath = picked[0].fsPath
    } else {
      privateKeyPath = await input('Private key path', defaults?.privateKeyPath)
      if (privateKeyPath === undefined) return undefined
    }
    passphrase = await input('Key passphrase (optional)', defaults?.passphrase, true)
    if (passphrase === undefined) return undefined
    if (!passphrase) passphrase = undefined
  }

  const label =
    (await input('Label', defaults?.label || `${username.trim()}@${host.trim()}`)) ??
    `${username.trim()}@${host.trim()}`

  let jumpHost: SshJumpHostOptions | undefined
  const useJump = await vscode.window.showQuickPick(
    [
      { label: 'No', value: false },
      { label: 'Yes — ProxyJump / bastion', value: true }
    ],
    { placeHolder: 'Use jump host?', ignoreFocusOut: true }
  )
  if (!useJump) return undefined
  if (useJump.value) {
    const jHost = await input('Jump host', defaults?.jumpHost?.host)
    if (jHost === undefined) return undefined
    const jPortStr = await input('Jump port', String(defaults?.jumpHost?.port ?? 22))
    if (jPortStr === undefined) return undefined
    const jUser = await input('Jump username', defaults?.jumpHost?.username)
    if (jUser === undefined) return undefined
    const jPass = await input('Jump password (optional)', defaults?.jumpHost?.password, true)
    if (jPass === undefined) return undefined
    const jKey = await input('Jump private key path (optional)', defaults?.jumpHost?.privateKeyPath)
    if (jKey === undefined) return undefined
    const jPhrase = await input('Jump key passphrase (optional)', defaults?.jumpHost?.passphrase, true)
    if (jPhrase === undefined) return undefined
    jumpHost = {
      host: jHost.trim(),
      port: Math.floor(Number(jPortStr)) || 22,
      username: (jUser || '').trim(),
      password: jPass || undefined,
      privateKeyPath: jKey?.trim() || undefined,
      passphrase: jPhrase || undefined
    }
  }

  let forwards: LocalPortForward[] | undefined
  const useFwd = await vscode.window.showQuickPick(
    [
      { label: 'No', value: false },
      { label: 'Yes — local port forward', value: true }
    ],
    { placeHolder: 'Add local port forward?', ignoreFocusOut: true }
  )
  if (!useFwd) return undefined
  if (useFwd.value) {
    const localPort = await input('Local port', '18080')
    if (localPort === undefined) return undefined
    const remoteHost = await input('Remote host', '127.0.0.1')
    if (remoteHost === undefined) return undefined
    const remotePort = await input('Remote port', '8080')
    if (remotePort === undefined) return undefined
    forwards = [
      {
        localPort: Math.floor(Number(localPort)) || 18080,
        remoteHost: (remoteHost || '127.0.0.1').trim(),
        remotePort: Math.floor(Number(remotePort)) || 8080
      }
    ]
  }

  return {
    host: host.trim(),
    port,
    username: username.trim(),
    password,
    privateKeyPath: privateKeyPath?.trim() || undefined,
    passphrase,
    label: label.trim(),
    jumpHost,
    forwards
  }
}

export async function promptSaveProfile(
  opts: SshConnectOptions,
  existingId?: string
): Promise<SavedSessionProfile> {
  return {
    id: existingId || randomUUID(),
    label: opts.label || `${opts.username}@${opts.host}`,
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.username,
    password: opts.password,
    privateKeyPath: opts.privateKeyPath,
    passphrase: opts.passphrase,
    jumpHost: opts.jumpHost,
    forwards: opts.forwards
  }
}
