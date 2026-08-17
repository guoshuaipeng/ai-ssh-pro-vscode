import type {
  LocalPortForward,
  SavedSessionProfile,
  SavedSessionsState,
  SshJumpHostOptions
} from '../shared/ipc'

type JumpHostPublic = Omit<SshJumpHostOptions, 'password' | 'passphrase'>

type ProfilePublic = Omit<SavedSessionProfile, 'password' | 'passphrase' | 'jumpHost'> & {
  jumpHost?: JumpHostPublic
}

function stripJumpSecrets(jump: SshJumpHostOptions): JumpHostPublic {
  const { password: _password, passphrase: _passphrase, ...rest } = jump
  return rest
}

function stripProfileSecrets(profile: SavedSessionProfile): ProfilePublic {
  const { password: _password, passphrase: _passphrase, jumpHost, ...rest } = profile
  const out: ProfilePublic = { ...rest }
  if (jumpHost) out.jumpHost = stripJumpSecrets(jumpHost)
  return out
}

/** 导出 JSON：保留 folders + profiles，去掉密码/口令（含跳板） */
export function exportSessionsToJson(state: SavedSessionsState): string {
  const payload = {
    folders: state.folders,
    profiles: state.profiles.map(stripProfileSecrets)
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

function sanitizeHostAlias(label: string): string {
  const cleaned = label
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'host'
}

function uniqueHostAlias(label: string, used: Set<string>): string {
  const base = sanitizeHostAlias(label)
  let name = base
  let n = 2
  while (used.has(name.toLowerCase())) {
    name = `${base}-${n}`
    n += 1
  }
  used.add(name.toLowerCase())
  return name
}

function formatIdentityFile(path: string): string {
  if (/[\s"'\\]/.test(path)) return `"${path.replace(/"/g, '\\"')}"`
  return path
}

function formatProxyJump(jump: SshJumpHostOptions): string {
  const port = jump.port != null && jump.port > 0 && jump.port !== 22 ? `:${jump.port}` : ''
  return `${jump.username}@${jump.host}${port}`
}

function formatLocalForward(f: LocalPortForward): string {
  return `${f.localPort} ${f.remoteHost}:${f.remotePort}`
}

function profileToOpenSshBlock(profile: SavedSessionProfile, alias: string): string {
  const lines: string[] = [`Host ${alias}`, `  HostName ${profile.host}`, `  User ${profile.username}`]
  if (profile.port > 0 && profile.port !== 22) {
    lines.push(`  Port ${profile.port}`)
  }
  if (profile.privateKeyPath?.trim()) {
    lines.push(`  IdentityFile ${formatIdentityFile(profile.privateKeyPath.trim())}`)
  }
  if (profile.jumpHost?.host?.trim() && profile.jumpHost.username?.trim()) {
    lines.push(`  ProxyJump ${formatProxyJump(profile.jumpHost)}`)
  }
  for (const fwd of profile.forwards ?? []) {
    if (fwd.localPort > 0 && fwd.remoteHost && fwd.remotePort > 0) {
      lines.push(`  LocalForward ${formatLocalForward(fwd)}`)
    }
  }
  return lines.join('\n')
}

/** 导出 OpenSSH config：Host 块，不含任何密码/口令 */
export function exportSessionsToOpenSsh(state: SavedSessionsState): string {
  const used = new Set<string>()
  const blocks: string[] = []
  for (const profile of state.profiles) {
    const alias = uniqueHostAlias(profile.label || profile.host, used)
    blocks.push(profileToOpenSshBlock(profile, alias))
  }
  if (blocks.length === 0) return ''
  return `${blocks.join('\n\n')}\n`
}
