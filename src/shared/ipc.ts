/** Shared types for AI-SSH-Pro VS Code extension (no AI chat types). */

export type SshJumpHostOptions = {
  host: string
  port?: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export type LocalPortForward = {
  localPort: number
  remoteHost: string
  remotePort: number
}

export type SessionMeta = {
  host: string
  port: number
  username: string
  label?: string
  connectedAt: number
  termCols: number
  termRows: number
  kind?: 'ssh' | 'local'
}

export type SshConnectOptions = {
  host: string
  port?: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  label?: string
  termCols?: number
  termRows?: number
  jumpHost?: SshJumpHostOptions
  forwards?: LocalPortForward[]
}

export type SshConnectResult = {
  sessionId: string
  meta: SessionMeta
}

export type SshDataEvent = {
  sessionId: string
  chunk: string | Uint8Array
}

export type SftpProgressEvent = {
  transferId: string
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  transferred: number
  total: number
  done?: boolean
  error?: string
}

export type SshStatusEvent = {
  sessionId: string
  status: 'connected' | 'error' | 'closed'
  message?: string
}

export type SshHostKeyPromptEvent = {
  requestId: string
  host: string
  port: number
  fingerprint: string
  reason: 'unknown' | 'changed'
  previousFingerprint?: string
}

export type SshHostKeyRespondPayload = {
  requestId: string
  accept: boolean
  alwaysTrust?: boolean
}

export type SshSnapshotOptions = {
  maxLines?: number
  fromCurrentCommand?: boolean
  includeCommandLine?: boolean
}

export type DockerContainer = {
  id: string
  name: string
  image: string
  state: string
  status: string
  shortStatus: string
  ports: string
  createdAt?: string
  composeProject?: string
  composeService?: string
  swarmService?: string
}

export type DockerComposeProject = {
  name: string
  status?: string
  configFiles?: string
  containers: DockerContainer[]
}

export type DockerComposeService = {
  name: string
  id?: string
  state: string
  status: string
  shortStatus: string
}

export type DockerSwarmPort = {
  targetPort: number
  publishedPort?: number
  protocol: string
  publishMode: string
}

export type DockerSwarmService = {
  id: string
  name: string
  image: string
  mode: string
  replicas: string
  runningTasks: number
  desiredTasks: number
  shortStatus: string
  ports: DockerSwarmPort[]
  stack?: string
  containers: DockerContainer[]
}

export type DockerSwarmStack = {
  name: string
  services: DockerSwarmService[]
}

export type DockerSwarmInfo = {
  active: boolean
  manager: boolean
  stacks: DockerSwarmStack[]
  error?: string
}

export type DockerSwarmTask = {
  id: string
  name: string
  node?: string
  image?: string
  currentState: string
  desiredState: string
  shortStatus: string
  error?: string
}

export type DockerSwarmResources = {
  limitCpu?: string
  limitMemory?: string
  reserveCpu?: string
  reserveMemory?: string
}

export type DockerSwarmServiceDetail = {
  id: string
  name: string
  image: string
  mode: string
  replicas: string
  stack?: string
  createdAt?: string
  updatedAt?: string
  command?: string
  user?: string
  workingDir?: string
  ports: DockerSwarmPort[]
  env: DockerKeyValue[]
  mounts: DockerMount[]
  networks: string[]
  labels: DockerKeyValue[]
  containerLabels: DockerKeyValue[]
  constraints: string[]
  hosts: string[]
  resources?: DockerSwarmResources
  updatePolicy?: string
  restartPolicy?: string
  healthcheck?: string
  tasks: DockerSwarmTask[]
}

export type DockerTreeResult = {
  containers: DockerContainer[]
  composeProjects: DockerComposeProject[]
  swarm: DockerSwarmInfo
  containersError?: string
  composeError?: string
}

export type DockerKeyValue = {
  key: string
  value: string
}

export type DockerPortBinding = {
  container: string
  hostIp?: string
  hostPort?: string
}

export type DockerMount = {
  type: string
  source: string
  destination: string
  readWrite: boolean
}

export type DockerNetworkInfo = {
  name: string
  ipAddress?: string
}

export type DockerContainerSwarmInfo = {
  service: string
  taskName?: string
  node?: string
  publishedPorts: DockerSwarmPort[]
  error?: string
}

export type DockerContainerDetail = {
  id: string
  name: string
  image: string
  command?: string
  workingDir?: string
  user?: string
  restartPolicy?: string
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  health?: string
  env: DockerKeyValue[]
  ports: DockerPortBinding[]
  mounts: DockerMount[]
  networks: DockerNetworkInfo[]
  labels: DockerKeyValue[]
  swarm?: DockerContainerSwarmInfo
}

export type DockerContainerAction = 'start' | 'stop' | 'restart' | 'rm'
export type DockerComposeAction = 'up' | 'down'
export type DockerSwarmAction = 'restart' | 'scale'

export type SftpListEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifyTime?: number
}

export type SftpListResult = {
  path: string
  entries: SftpListEntry[]
}

export type SftpReadTextResult = {
  path: string
  content: string
  size: number
  truncated: boolean
  encoding: 'utf-8'
}

export type SavedSessionFolder = {
  id: string
  name: string
}

export type SavedSessionProfile = {
  id: string
  label: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  folderId?: string
  jumpHost?: SshJumpHostOptions
  forwards?: LocalPortForward[]
  hostInventoryId?: string
}

export type SavedSessionsState = {
  folders: SavedSessionFolder[]
  profiles: SavedSessionProfile[]
}

export type ImportedSessionDraft = {
  label: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  jumpHost?: SshJumpHostOptions
  forwards?: LocalPortForward[]
}

export type SessionImportPickResult = {
  items: ImportedSessionDraft[]
  notes: string[]
}

export type SessionExportFormat = 'json' | 'openssh'

export type CommandSnippet = {
  id: string
  title: string
  body: string
}

export type TerminalThemeId = 'github-dark' | 'solarized-dark' | 'monokai'

export type TerminalPrefs = {
  themeId: TerminalThemeId
  fontFamily: string
  fontSize: number
  scrollback: number
}

export const TERMINAL_PREFS_DEFAULTS: TerminalPrefs = {
  themeId: 'github-dark',
  fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 4000
}
