/** 主机知识库（Inventory）共享类型 — 本软件 Agent 与 MCP 共用同一份文件约定 */

export type HostServiceKind = 'systemd' | 'docker' | 'k8s' | 'binary' | 'unknown'

export type HostService = {
  name: string
  kind: HostServiceKind
  ports?: number[]
  unit?: string
  image?: string
  composeDir?: string
  notes?: string
}

export type HostMeta = {
  id: string
  /** 展示名 */
  title: string
  host?: string
  port?: number
  username?: string
  /** 关联侧栏已保存会话 id */
  profileId?: string
  /** 本机私钥路径（密钥登录；勿把私钥内容写入仓库） */
  privateKeyPath?: string
  tags?: string[]
  env?: string
  updatedAt: number
  createdAt: number
}

export type HostServicesFile = {
  hostId: string
  updatedAt: number
  services: HostService[]
}

export type HostInventoryRecord = {
  meta: HostMeta
  services: HostService[]
  notesMarkdown: string
}

export type HostInventoryIndexEntry = {
  id: string
  title: string
  host?: string
  port?: number
  username?: string
  profileId?: string
  tags?: string[]
  updatedAt: number
}

export type HostInventoryIndex = {
  version: 1
  rootHint?: string
  hosts: HostInventoryIndexEntry[]
}

export type HostInventoryUpsertInput = {
  id?: string
  title: string
  host?: string
  port?: number
  username?: string
  profileId?: string
  privateKeyPath?: string
  tags?: string[]
  env?: string
  services?: HostService[]
  notesMarkdown?: string
}

/** 注入 Agent 的摘要文本上限 */
export const INVENTORY_CONTEXT_MAX_CHARS = 6000
