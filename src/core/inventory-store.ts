import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  HostInventoryIndex,
  HostInventoryIndexEntry,
  HostInventoryRecord,
  HostInventoryUpsertInput,
  HostMeta,
  HostService,
  HostServicesFile
} from '../shared/inventory'
import { INVENTORY_CONTEXT_MAX_CHARS } from '../shared/inventory'

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function slugify(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.slice(0, 64) || `host-${randomUUID().slice(0, 8)}`
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** Resolve inventory root: env AISS_INVENTORY_ROOT > override > ~/.ai-ssh-pro/inventory */
export function resolveInventoryRoot(override?: string | null): string {
  const fromEnv = process.env.AISS_INVENTORY_ROOT?.trim()
  if (fromEnv) return fromEnv
  if (override?.trim()) return override.trim()
  return join(homedir(), '.ai-ssh-pro', 'inventory')
}

export class InventoryStore {
  readonly root: string

  constructor(root?: string | null) {
    this.root = resolveInventoryRoot(root)
    ensureDir(this.root)
    ensureDir(this.hostsDir())
    if (!existsSync(this.indexPath())) {
      writeJsonFile(this.indexPath(), { version: 1, hosts: [] } satisfies HostInventoryIndex)
    }
  }

  private indexPath(): string {
    return join(this.root, 'index.json')
  }

  private hostsDir(): string {
    return join(this.root, 'hosts')
  }

  private hostDir(id: string): string {
    return join(this.hostsDir(), id)
  }

  private readIndex(): HostInventoryIndex {
    const idx = readJsonFile<HostInventoryIndex>(this.indexPath(), { version: 1, hosts: [] })
    if (!Array.isArray(idx.hosts)) idx.hosts = []
    idx.version = 1
    return idx
  }

  private writeIndex(idx: HostInventoryIndex): void {
    writeJsonFile(this.indexPath(), idx)
  }

  private rebuildIndexFromDisk(): HostInventoryIndex {
    const hosts: HostInventoryIndexEntry[] = []
    const dir = this.hostsDir()
    if (!existsSync(dir)) return { version: 1, hosts: [] }
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const rec = this.get(name.name)
      if (!rec) continue
      hosts.push(this.toIndexEntry(rec.meta))
    }
    hosts.sort((a, b) => b.updatedAt - a.updatedAt)
    const idx: HostInventoryIndex = { version: 1, rootHint: this.root, hosts }
    this.writeIndex(idx)
    return idx
  }

  private toIndexEntry(meta: HostMeta): HostInventoryIndexEntry {
    return {
      id: meta.id,
      title: meta.title,
      host: meta.host,
      port: meta.port,
      username: meta.username,
      profileId: meta.profileId,
      tags: meta.tags,
      updatedAt: meta.updatedAt
    }
  }

  list(): HostInventoryIndexEntry[] {
    const idx = this.readIndex()
    if (idx.hosts.length === 0) {
      return this.rebuildIndexFromDisk().hosts
    }
    return [...idx.hosts].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): HostInventoryRecord | null {
    const hid = id.trim()
    if (!hid) return null
    const dir = this.hostDir(hid)
    if (!existsSync(dir)) return null
    const meta = readJsonFile<HostMeta | null>(join(dir, 'meta.json'), null)
    if (!meta || !meta.id) return null
    const servicesFile = readJsonFile<HostServicesFile>(join(dir, 'services.json'), {
      hostId: hid,
      updatedAt: meta.updatedAt,
      services: []
    })
    let notesMarkdown = ''
    try {
      notesMarkdown = readFileSync(join(dir, 'notes.md'), 'utf8')
    } catch {
      notesMarkdown = ''
    }
    return {
      meta,
      services: Array.isArray(servicesFile.services) ? servicesFile.services : [],
      notesMarkdown
    }
  }

  findByHostPort(host: string, port = 22): HostInventoryRecord | null {
    const h = host.trim().toLowerCase()
    const p = port > 0 ? port : 22
    if (!h) return null
    for (const e of this.list()) {
      if ((e.host || '').toLowerCase() === h && (e.port ?? 22) === p) {
        return this.get(e.id)
      }
    }
    return null
  }

  findByProfileId(profileId: string): HostInventoryRecord | null {
    const pid = profileId.trim()
    if (!pid) return null
    for (const e of this.list()) {
      if (e.profileId === pid) return this.get(e.id)
    }
    return null
  }

  search(query: string): HostInventoryIndexEntry[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.list()
    const out: HostInventoryIndexEntry[] = []
    for (const e of this.list()) {
      const rec = this.get(e.id)
      if (!rec) continue
      const hay = [
        rec.meta.title,
        rec.meta.host,
        rec.meta.username,
        rec.meta.env,
        ...(rec.meta.tags || []),
        ...rec.services.map((s) => `${s.name} ${s.kind} ${s.notes || ''}`),
        rec.notesMarkdown
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      if (hay.includes(q)) out.push(e)
    }
    return out
  }

  upsert(input: HostInventoryUpsertInput): HostInventoryRecord {
    const now = Date.now()
    let id = input.id?.trim() || ''
    if (!id) id = slugify(input.title || input.host || 'host')
    // avoid collision
    if (!input.id) {
      let candidate = id
      let n = 2
      while (existsSync(this.hostDir(candidate)) && !input.id) {
        candidate = `${id}-${n}`
        n++
      }
      id = candidate
    }

    const existing = this.get(id)
    const createdAt = existing?.meta.createdAt ?? now
    const meta: HostMeta = {
      id,
      title: (input.title || existing?.meta.title || id).trim(),
      host: input.host?.trim() || existing?.meta.host,
      port: input.port ?? existing?.meta.port ?? 22,
      username: input.username?.trim() || existing?.meta.username,
      profileId: input.profileId?.trim() || existing?.meta.profileId,
      privateKeyPath: input.privateKeyPath?.trim() || existing?.meta.privateKeyPath,
      tags: input.tags ?? existing?.meta.tags,
      env: input.env?.trim() || existing?.meta.env,
      createdAt,
      updatedAt: now
    }
    const services = input.services ?? existing?.services ?? []
    const notesMarkdown =
      input.notesMarkdown != null ? input.notesMarkdown : (existing?.notesMarkdown ?? '')

    const dir = this.hostDir(id)
    ensureDir(dir)
    writeJsonFile(join(dir, 'meta.json'), meta)
    writeJsonFile(join(dir, 'services.json'), {
      hostId: id,
      updatedAt: now,
      services
    } satisfies HostServicesFile)
    writeFileSync(join(dir, 'notes.md'), notesMarkdown, 'utf8')

    const idx = this.readIndex()
    const entry = this.toIndexEntry(meta)
    const i = idx.hosts.findIndex((h) => h.id === id)
    if (i >= 0) idx.hosts[i] = entry
    else idx.hosts.push(entry)
    idx.rootHint = this.root
    this.writeIndex(idx)

    return { meta, services, notesMarkdown }
  }

  upsertService(hostId: string, service: HostService): HostInventoryRecord | null {
    const rec = this.get(hostId)
    if (!rec) return null
    const name = service.name.trim()
    if (!name) throw new Error('service.name 不能为空')
    const next = [...rec.services]
    const i = next.findIndex((s) => s.name.toLowerCase() === name.toLowerCase())
    const row: HostService = { ...service, name }
    if (i >= 0) next[i] = { ...next[i], ...row }
    else next.push(row)
    return this.upsert({
      id: hostId,
      title: rec.meta.title,
      host: rec.meta.host,
      port: rec.meta.port,
      username: rec.meta.username,
      profileId: rec.meta.profileId,
      tags: rec.meta.tags,
      env: rec.meta.env,
      services: next,
      notesMarkdown: rec.notesMarkdown
    })
  }

  appendNote(hostId: string, note: string): HostInventoryRecord | null {
    const rec = this.get(hostId)
    if (!rec) return null
    const stamp = new Date().toISOString()
    const block = `\n\n## ${stamp}\n\n${note.trim()}\n`
    return this.upsert({
      id: hostId,
      title: rec.meta.title,
      host: rec.meta.host,
      port: rec.meta.port,
      username: rec.meta.username,
      profileId: rec.meta.profileId,
      tags: rec.meta.tags,
      env: rec.meta.env,
      services: rec.services,
      notesMarkdown: `${rec.notesMarkdown.trimEnd()}${block}`
    })
  }

  appendFact(hostId: string, fact: string): void {
    const dir = this.hostDir(hostId)
    if (!existsSync(dir)) return
    const line = JSON.stringify({ at: Date.now(), text: fact.slice(0, 4000) })
    writeFileSync(join(dir, 'facts.jsonl'), `${line}\n`, { flag: 'a', encoding: 'utf8' })
  }

  remove(id: string): boolean {
    const hid = id.trim()
    const dir = this.hostDir(hid)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    const idx = this.readIndex()
    idx.hosts = idx.hosts.filter((h) => h.id !== hid)
    this.writeIndex(idx)
    return true
  }

  /** Compact text for Core-A system prompt */
  formatContext(idOrHost: { hostId?: string; host?: string; port?: number; profileId?: string }): string {
    let rec: HostInventoryRecord | null = null
    if (idOrHost.hostId) rec = this.get(idOrHost.hostId)
    if (!rec && idOrHost.profileId) rec = this.findByProfileId(idOrHost.profileId)
    if (!rec && idOrHost.host) rec = this.findByHostPort(idOrHost.host, idOrHost.port ?? 22)
    if (!rec) return ''

    const lines: string[] = [
      `主机档案 id=${rec.meta.id} title=${rec.meta.title}`,
      rec.meta.host ? `连接：${rec.meta.username || '?'}@${rec.meta.host}:${rec.meta.port ?? 22}` : '',
      rec.meta.privateKeyPath ? `私钥：${rec.meta.privateKeyPath}` : '',
      rec.meta.env ? `环境：${rec.meta.env}` : '',
      rec.meta.tags?.length ? `标签：${rec.meta.tags.join(', ')}` : '',
      '服务清单：'
    ]
    if (rec.services.length === 0) lines.push('（暂无登记服务）')
    else {
      for (const s of rec.services) {
        const ports = s.ports?.length ? ` ports=${s.ports.join(',')}` : ''
        const extra = [s.unit, s.image, s.composeDir, s.notes].filter(Boolean).join(' | ')
        lines.push(`- ${s.name} [${s.kind}]${ports}${extra ? ` — ${extra}` : ''}`)
      }
    }
    if (rec.notesMarkdown.trim()) {
      lines.push('运维备注：')
      lines.push(rec.notesMarkdown.trim().slice(0, 2500))
    }
    let text = lines.filter(Boolean).join('\n')
    if (text.length > INVENTORY_CONTEXT_MAX_CHARS) {
      text = text.slice(0, INVENTORY_CONTEXT_MAX_CHARS) + '\n…(已截断)'
    }
    return text
  }
}

let singleton: InventoryStore | null = null

export function getInventoryStore(root?: string | null): InventoryStore {
  if (root != null) return new InventoryStore(root)
  if (!singleton) singleton = new InventoryStore()
  return singleton
}
