import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  SavedSessionFolder,
  SavedSessionProfile,
  SavedSessionsState,
  TerminalPrefs,
  CommandSnippet,
  SshJumpHostOptions,
  LocalPortForward
} from '../shared/ipc'
import { TERMINAL_PREFS_DEFAULTS } from '../shared/ipc'

export type SecretsAdapter = {
  get(key: string): Thenable<string | undefined>
  store(key: string, value: string): Thenable<void>
  delete(key: string): Thenable<void>
}

type StoreData = {
  savedSessions: SavedSessionsState
  terminalPrefs: TerminalPrefs
  snippets: CommandSnippet[]
}

const STORE_PATH = join(homedir(), '.ai-ssh-pro', 'vscode-store.json')
const SECRET_PREFIX = 'secret:'

function secretKeyPassword(profileId: string): string {
  return `secret:profile:${profileId}:password`
}

function secretKeyPassphrase(profileId: string): string {
  return `secret:profile:${profileId}:passphrase`
}

function secretKeyJumpPassword(profileId: string): string {
  return `secret:profile:${profileId}:jump:password`
}

function secretKeyJumpPassphrase(profileId: string): string {
  return `secret:profile:${profileId}:jump:passphrase`
}

function ensureParentDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readStoreFile(): StoreData {
  const defaults: StoreData = {
    savedSessions: { folders: [], profiles: [] },
    terminalPrefs: { ...TERMINAL_PREFS_DEFAULTS },
    snippets: []
  }
  try {
    if (!existsSync(STORE_PATH)) return defaults
    const raw = readFileSync(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreData>
    return {
      savedSessions: normalizeSavedSessionsRaw(parsed.savedSessions),
      terminalPrefs: normalizeTerminalPrefs(parsed.terminalPrefs),
      snippets: normalizeSnippets(parsed.snippets)
    }
  } catch {
    return defaults
  }
}

function writeStoreFile(data: StoreData): void {
  ensureParentDir(STORE_PATH)
  writeFileSync(STORE_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function isSecretRef(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX)
}

function normalizeForwards(raw: unknown): LocalPortForward[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: LocalPortForward[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const localPort = typeof o.localPort === 'number' ? Math.floor(o.localPort) : NaN
    const remotePort = typeof o.remotePort === 'number' ? Math.floor(o.remotePort) : NaN
    const remoteHost = typeof o.remoteHost === 'string' ? o.remoteHost.trim() : ''
    if (!remoteHost || !(localPort > 0 && localPort < 65536) || !(remotePort > 0 && remotePort < 65536)) continue
    out.push({ localPort, remoteHost, remotePort })
  }
  return out.length ? out : undefined
}

function normalizeJump(raw: unknown): SshJumpHostOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const host = typeof o.host === 'string' ? o.host.trim() : ''
  const username = typeof o.username === 'string' ? o.username.trim() : ''
  if (!host || !username) return undefined
  const port = typeof o.port === 'number' && Number.isFinite(o.port) ? Math.floor(o.port) : 22
  const jump: SshJumpHostOptions = { host, port: port > 0 ? port : 22, username }
  if (typeof o.password === 'string' && o.password) jump.password = o.password
  if (typeof o.privateKeyPath === 'string' && o.privateKeyPath.trim()) jump.privateKeyPath = o.privateKeyPath.trim()
  if (typeof o.passphrase === 'string' && o.passphrase) jump.passphrase = o.passphrase
  return jump
}

function normalizeSavedSessionsRaw(raw: unknown): SavedSessionsState {
  const normalizeFolder = (x: unknown): SavedSessionFolder | null => {
    if (!x || typeof x !== 'object') return null
    const o = x as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null
    if (!id || !name) return null
    return { id, name }
  }

  const normalizeProfile = (x: unknown): SavedSessionProfile | null => {
    if (!x || typeof x !== 'object') return null
    const o = x as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : null
    const host = typeof o.host === 'string' && o.host.trim() ? o.host.trim() : null
    const username = typeof o.username === 'string' && o.username.trim() ? o.username.trim() : null
    const port = typeof o.port === 'number' && Number.isFinite(o.port) ? Math.floor(o.port) : 22
    if (!id || !label || !host || !username) return null
    const folderId = typeof o.folderId === 'string' && o.folderId.trim() ? o.folderId.trim() : undefined
    const row: SavedSessionProfile = { id, label, host, port: port > 0 ? port : 22, username }
    if (folderId) row.folderId = folderId
    if (typeof o.password === 'string' && o.password) row.password = o.password
    if (typeof o.privateKeyPath === 'string' && o.privateKeyPath.trim()) row.privateKeyPath = o.privateKeyPath.trim()
    if (typeof o.passphrase === 'string' && o.passphrase) row.passphrase = o.passphrase
    const jump = normalizeJump(o.jumpHost)
    if (jump) row.jumpHost = jump
    const forwards = normalizeForwards(o.forwards)
    if (forwards) row.forwards = forwards
    if (typeof o.hostInventoryId === 'string' && o.hostInventoryId.trim()) {
      row.hostInventoryId = o.hostInventoryId.trim()
    }
    return row
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    const folders = Array.isArray(o.folders)
      ? (o.folders.map(normalizeFolder).filter(Boolean) as SavedSessionFolder[])
      : []
    const profiles = Array.isArray(o.profiles)
      ? (o.profiles.map(normalizeProfile).filter(Boolean) as SavedSessionProfile[])
      : []
    return { folders, profiles }
  }

  if (Array.isArray(raw)) {
    const profiles = raw.map(normalizeProfile).filter(Boolean) as SavedSessionProfile[]
    return { folders: [], profiles }
  }

  return { folders: [], profiles: [] }
}

function normalizeTerminalPrefs(raw: unknown): TerminalPrefs {
  const d = TERMINAL_PREFS_DEFAULTS
  if (!raw || typeof raw !== 'object') return { ...d }
  const o = raw as Record<string, unknown>
  const themeId =
    o.themeId === 'github-dark' || o.themeId === 'solarized-dark' || o.themeId === 'monokai'
      ? o.themeId
      : d.themeId
  const fontFamily = typeof o.fontFamily === 'string' && o.fontFamily.trim() ? o.fontFamily.trim() : d.fontFamily
  const fontSize =
    typeof o.fontSize === 'number' && Number.isFinite(o.fontSize)
      ? Math.min(32, Math.max(10, Math.floor(o.fontSize)))
      : d.fontSize
  const scrollback =
    typeof o.scrollback === 'number' && Number.isFinite(o.scrollback)
      ? Math.min(50000, Math.max(500, Math.floor(o.scrollback)))
      : d.scrollback
  return { themeId, fontFamily, fontSize, scrollback }
}

function normalizeSnippets(raw: unknown): CommandSnippet[] {
  if (!Array.isArray(raw)) return []
  const out: CommandSnippet[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null
    const body = typeof o.body === 'string' ? o.body : null
    if (!id || !title || body == null) continue
    out.push({ id, title, body })
  }
  return out
}

async function resolveSecret(
  secrets: SecretsAdapter,
  value: string | undefined
): Promise<string | undefined> {
  if (!value) return undefined
  if (!isSecretRef(value)) return value
  try {
    return (await secrets.get(value)) ?? undefined
  } catch (e) {
    console.error('[app-store] failed to load secret', value, e)
    return undefined
  }
}

async function hydrateProfile(
  secrets: SecretsAdapter,
  profile: SavedSessionProfile
): Promise<SavedSessionProfile> {
  const row: SavedSessionProfile = { ...profile }
  const password = await resolveSecret(secrets, row.password)
  if (password) row.password = password
  else delete row.password

  const passphrase = await resolveSecret(secrets, row.passphrase)
  if (passphrase) row.passphrase = passphrase
  else delete row.passphrase

  if (row.jumpHost) {
    const jump: SshJumpHostOptions = { ...row.jumpHost }
    const jp = await resolveSecret(secrets, jump.password)
    if (jp) jump.password = jp
    else delete jump.password
    const jpp = await resolveSecret(secrets, jump.passphrase)
    if (jpp) jump.passphrase = jpp
    else delete jump.passphrase
    row.jumpHost = jump
  }
  return row
}

async function persistSecret(
  secrets: SecretsAdapter,
  key: string,
  value: string | undefined
): Promise<string | undefined> {
  if (!value) {
    try {
      await secrets.delete(key)
    } catch {
      /* ignore */
    }
    return undefined
  }
  await secrets.store(key, value)
  return key
}

async function dehydrateProfile(
  secrets: SecretsAdapter,
  profile: SavedSessionProfile
): Promise<SavedSessionProfile> {
  const row: SavedSessionProfile = { ...profile }
  const pwRef = await persistSecret(secrets, secretKeyPassword(profile.id), profile.password)
  if (pwRef) row.password = pwRef
  else delete row.password

  const ppRef = await persistSecret(secrets, secretKeyPassphrase(profile.id), profile.passphrase)
  if (ppRef) row.passphrase = ppRef
  else delete row.passphrase

  if (profile.jumpHost) {
    const jump: SshJumpHostOptions = {
      host: profile.jumpHost.host,
      port: profile.jumpHost.port,
      username: profile.jumpHost.username,
      privateKeyPath: profile.jumpHost.privateKeyPath
    }
    const jpRef = await persistSecret(
      secrets,
      secretKeyJumpPassword(profile.id),
      profile.jumpHost.password
    )
    if (jpRef) jump.password = jpRef
    const jppRef = await persistSecret(
      secrets,
      secretKeyJumpPassphrase(profile.id),
      profile.jumpHost.passphrase
    )
    if (jppRef) jump.passphrase = jppRef
    row.jumpHost = jump
  } else {
    await persistSecret(secrets, secretKeyJumpPassword(profile.id), undefined)
    await persistSecret(secrets, secretKeyJumpPassphrase(profile.id), undefined)
  }

  return row
}

async function deleteProfileSecrets(secrets: SecretsAdapter, profileId: string): Promise<void> {
  await Promise.all([
    persistSecret(secrets, secretKeyPassword(profileId), undefined),
    persistSecret(secrets, secretKeyPassphrase(profileId), undefined),
    persistSecret(secrets, secretKeyJumpPassword(profileId), undefined),
    persistSecret(secrets, secretKeyJumpPassphrase(profileId), undefined)
  ])
}

export class AppStore {
  constructor(private readonly secrets: SecretsAdapter) {}

  async getSavedSessionsState(): Promise<SavedSessionsState> {
    const data = readStoreFile()
    const profiles = await Promise.all(data.savedSessions.profiles.map((p) => hydrateProfile(this.secrets, p)))
    return { folders: data.savedSessions.folders, profiles }
  }

  async setSavedSessionsState(state: SavedSessionsState): Promise<void> {
    const data = readStoreFile()
    const prevIds = new Set(data.savedSessions.profiles.map((p) => p.id))
    const nextIds = new Set(state.profiles.map((p) => p.id))

    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        await deleteProfileSecrets(this.secrets, id)
      }
    }

    const profiles = await Promise.all(state.profiles.map((p) => dehydrateProfile(this.secrets, p)))
    data.savedSessions = {
      folders: state.folders,
      profiles
    }
    writeStoreFile(data)
  }

  getTerminalPrefs(): TerminalPrefs {
    return normalizeTerminalPrefs(readStoreFile().terminalPrefs)
  }

  setTerminalPrefs(partial: Partial<TerminalPrefs>): TerminalPrefs {
    const data = readStoreFile()
    const next = normalizeTerminalPrefs({ ...data.terminalPrefs, ...partial })
    data.terminalPrefs = next
    writeStoreFile(data)
    return next
  }

  getSnippets(): CommandSnippet[] {
    return normalizeSnippets(readStoreFile().snippets)
  }

  setSnippets(list: CommandSnippet[]): void {
    const data = readStoreFile()
    data.snippets = normalizeSnippets(list)
    writeStoreFile(data)
  }

  async upsertProfile(profile: SavedSessionProfile): Promise<void> {
    const state = await this.getSavedSessionsState()
    const idx = state.profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) state.profiles[idx] = profile
    else state.profiles.push(profile)
    await this.setSavedSessionsState(state)
  }

  async deleteProfile(id: string): Promise<void> {
    const state = await this.getSavedSessionsState()
    state.profiles = state.profiles.filter((p) => p.id !== id)
    await this.setSavedSessionsState(state)
  }

  async addFolder(name: string): Promise<SavedSessionFolder> {
    const state = await this.getSavedSessionsState()
    const folder: SavedSessionFolder = { id: randomUUID(), name: name.trim() }
    state.folders.push(folder)
    await this.setSavedSessionsState(state)
    return folder
  }

  async deleteFolder(id: string): Promise<void> {
    const state = await this.getSavedSessionsState()
    state.folders = state.folders.filter((f) => f.id !== id)
    state.profiles = state.profiles.map((p) => {
      if (p.folderId !== id) return p
      const { folderId: _f, ...rest } = p
      return rest
    })
    await this.setSavedSessionsState(state)
  }
}

/** Factory helper for extension activation */
export function createAppStore(secrets: SecretsAdapter): AppStore {
  return new AppStore(secrets)
}
