#!/usr/bin/env node
/**
 * Host Inventory MCP / CLI — shares ~/.ai-ssh-pro/inventory (or AISS_INVENTORY_ROOT)
 * with AI-SSH-Pro. Same JSON layout as src/main/inventory-store.ts.
 *
 * Usage:
 *   node scripts/mcp-inventory-server.mjs --list
 *   node scripts/mcp-inventory-server.mjs --get <id>
 *   node scripts/mcp-inventory-server.mjs --search <query>
 *   node scripts/mcp-inventory-server.mjs --upload <hostId> <localPath> <remotePath>
 *   node scripts/mcp-inventory-server.mjs --exec <hostId> <command>
 *   npx @modelcontextprotocol/sdk ... OR run as MCP stdio when SDK present:
 *   npm run mcp:inventory
 *
 * Cursor mcp.json example:
 * {
 *   "mcpServers": {
 *     "ai-ssh-inventory": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/ai-ssh-pro/scripts/mcp-inventory-server.mjs"],
 *       "env": { "AISS_INVENTORY_ROOT": "/home/YOU/.ai-ssh-pro/inventory" }
 *     }
 *   }
 * }
 */
import { createInterface } from 'node:readline'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('ssh2')
const DEFAULT_SSH_KEY =
  process.env.AISS_SSH_KEY?.trim() || join(homedir(), '.ai-ssh-pro', 'keys', 'aiss_ed25519')
const SSH_TIMEOUT_MS = Number(process.env.AISS_SSH_TIMEOUT_MS) || 20_000

function resolveRoot() {
  const fromEnv = process.env.AISS_INVENTORY_ROOT?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.ai-ssh-pro', 'inventory')
}

const ROOT = resolveRoot()
const INDEX = join(ROOT, 'index.json')
const HOSTS = join(ROOT, 'hosts')

function ensure() {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true })
  if (!existsSync(HOSTS)) mkdirSync(HOSTS, { recursive: true })
  if (!existsSync(INDEX)) writeFileSync(INDEX, JSON.stringify({ version: 1, hosts: [] }, null, 2) + '\n')
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function listHosts() {
  ensure()
  const idx = readJson(INDEX, { version: 1, hosts: [] })
  return Array.isArray(idx.hosts) ? idx.hosts : []
}

function getHost(id) {
  ensure()
  const dir = join(HOSTS, id)
  if (!existsSync(dir)) return null
  const meta = readJson(join(dir, 'meta.json'), null)
  if (!meta) return null
  const servicesFile = readJson(join(dir, 'services.json'), { services: [] })
  let notesMarkdown = ''
  try {
    notesMarkdown = readFileSync(join(dir, 'notes.md'), 'utf8')
  } catch {
    /* empty */
  }
  return { meta, services: servicesFile.services || [], notesMarkdown }
}

function searchHosts(query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return listHosts()
  const out = []
  for (const e of listHosts()) {
    const rec = getHost(e.id)
    if (!rec) continue
    const hay = [
      rec.meta.title,
      rec.meta.host,
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

function upsertHost(input) {
  ensure()
  const now = Date.now()
  let id = (input.id || '').trim()
  if (!id) {
    id = String(input.title || input.host || 'host')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || `host-${randomUUID().slice(0, 8)}`
  }
  const existing = getHost(id)
  const dir = join(HOSTS, id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const meta = {
    id,
    title: (input.title || existing?.meta.title || id).trim(),
    host: input.host || existing?.meta.host,
    port: input.port ?? existing?.meta.port ?? 22,
    username: input.username || existing?.meta.username,
    profileId: input.profileId || existing?.meta.profileId,
    privateKeyPath: input.privateKeyPath || existing?.meta.privateKeyPath,
    tags: input.tags ?? existing?.meta.tags,
    env: input.env || existing?.meta.env,
    createdAt: existing?.meta.createdAt ?? now,
    updatedAt: now
  }
  const services = input.services ?? existing?.services ?? []
  const notesMarkdown = input.notesMarkdown != null ? input.notesMarkdown : (existing?.notesMarkdown ?? '')
  writeJson(join(dir, 'meta.json'), meta)
  writeJson(join(dir, 'services.json'), { hostId: id, updatedAt: now, services })
  writeFileSync(join(dir, 'notes.md'), notesMarkdown, 'utf8')
  const idx = readJson(INDEX, { version: 1, hosts: [] })
  const entry = {
    id,
    title: meta.title,
    host: meta.host,
    port: meta.port,
    username: meta.username,
    profileId: meta.profileId,
    tags: meta.tags,
    updatedAt: meta.updatedAt
  }
  const i = idx.hosts.findIndex((h) => h.id === id)
  if (i >= 0) idx.hosts[i] = entry
  else idx.hosts.push(entry)
  idx.rootHint = ROOT
  writeJson(INDEX, idx)
  return { meta, services, notesMarkdown }
}

function upsertService(hostId, service) {
  const rec = getHost(hostId)
  if (!rec) return null
  const name = String(service.name || '').trim()
  if (!name) throw new Error('service.name required')
  const next = [...rec.services]
  const i = next.findIndex((s) => s.name.toLowerCase() === name.toLowerCase())
  const row = { ...service, name }
  if (i >= 0) next[i] = { ...next[i], ...row }
  else next.push(row)
  return upsertHost({
    id: hostId,
    title: rec.meta.title,
    host: rec.meta.host,
    port: rec.meta.port,
    username: rec.meta.username,
    profileId: rec.meta.profileId,
    privateKeyPath: rec.meta.privateKeyPath,
    tags: rec.meta.tags,
    env: rec.meta.env,
    services: next,
    notesMarkdown: rec.notesMarkdown
  })
}

function appendNote(hostId, note) {
  const rec = getHost(hostId)
  if (!rec) return null
  const stamp = new Date().toISOString()
  const notesMarkdown = `${rec.notesMarkdown.trimEnd()}\n\n## ${stamp}\n\n${String(note).trim()}\n`
  return upsertHost({
    id: hostId,
    title: rec.meta.title,
    host: rec.meta.host,
    port: rec.meta.port,
    username: rec.meta.username,
    profileId: rec.meta.profileId,
    privateKeyPath: rec.meta.privateKeyPath,
    tags: rec.meta.tags,
    env: rec.meta.env,
    services: rec.services,
    notesMarkdown
  })
}

function resolvePrivateKeyPath(meta) {
  const p = (meta?.privateKeyPath || DEFAULT_SSH_KEY || '').trim()
  if (!p) throw new Error('privateKeyPath not set on host and AISS_SSH_KEY missing')
  if (!existsSync(p)) throw new Error(`private key not found: ${p}`)
  return p
}

function sshConnect(opts) {
  return new Promise((resolve, reject) => {
    const c = new Client()
    const t = setTimeout(() => {
      c.destroy()
      reject(new Error(`ssh connect timeout ${SSH_TIMEOUT_MS}ms`))
    }, SSH_TIMEOUT_MS)
    c.on('ready', () => {
      clearTimeout(t)
      resolve(c)
    })
    c.on('error', (err) => {
      clearTimeout(t)
      reject(err)
    })
    c.connect({
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      privateKey: opts.privateKey,
      readyTimeout: SSH_TIMEOUT_MS,
      hostVerifier: () => true
    })
  })
}

function sshExecRaw(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (d) => {
        stdout += d.toString()
      })
      stream.stderr.on('data', (d) => {
        stderr += d.toString()
      })
      stream.on('close', (code) => {
        resolve({ code: code ?? 0, stdout, stderr })
      })
    })
  })
}

function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function toPosixRemote(p) {
  return String(p || '').replace(/\\/g, '/').trim()
}

async function openHostClient(hostId) {
  const rec = getHost(hostId)
  if (!rec?.meta?.host) throw new Error(`host not found or missing host: ${hostId}`)
  const username = rec.meta.username || 'root'
  const keyPath = resolvePrivateKeyPath(rec.meta)
  const privateKey = readFileSync(keyPath)
  const client = await sshConnect({
    host: rec.meta.host,
    port: rec.meta.port || 22,
    username,
    privateKey
  })
  return { client, rec, username, keyPath }
}

function sftpFastPut(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err || !sftp) return reject(err || new Error('sftp unavailable'))
      sftp.fastPut(localPath, remotePath, (putErr) => {
        try {
          sftp.end()
        } catch {
          /* ignore */
        }
        if (putErr) reject(putErr)
        else resolve()
      })
    })
  })
}

async function sshExecOnHost(hostId, command) {
  const cmd = String(command || '').trim()
  if (!cmd) throw new Error('command required')
  const { client, rec, username, keyPath } = await openHostClient(hostId)
  try {
    const result = await sshExecRaw(client, cmd)
    return {
      hostId,
      host: rec.meta.host,
      username,
      privateKeyPath: keyPath,
      ...result
    }
  } finally {
    client.end()
  }
}

async function sshTestHost(hostId) {
  return sshExecOnHost(hostId, 'echo OK; whoami; hostname; pwd')
}

/**
 * Upload a local file to remote path via SFTP (ssh2).
 * @param {string} hostId
 * @param {string} localPath
 * @param {string} remotePath - remote file path; if ends with /, appends local basename
 * @param {{ mkdirParents?: boolean }} [opts]
 */
async function sshUpload(hostId, localPath, remotePath, opts = {}) {
  const local = String(localPath || '').trim()
  let remote = toPosixRemote(remotePath)
  if (!local) throw new Error('localPath required')
  if (!remote) throw new Error('remotePath required')
  if (!existsSync(local)) throw new Error(`local file not found: ${local}`)
  const st = statSync(local)
  if (!st.isFile()) throw new Error(`localPath is not a file: ${local}`)

  if (remote.endsWith('/')) remote = `${remote}${basename(local)}`

  const mkdirParents = opts.mkdirParents !== false
  const { client, rec, username, keyPath } = await openHostClient(hostId)
  try {
    if (mkdirParents) {
      const slash = remote.lastIndexOf('/')
      const dir = slash > 0 ? remote.slice(0, slash) : ''
      if (dir && dir !== '.') {
        const mk = await sshExecRaw(client, `mkdir -p ${shSingleQuote(dir)}`)
        if (mk.code !== 0) {
          throw new Error(`mkdir -p failed: ${(mk.stderr || mk.stdout || '').trim()}`)
        }
      }
    }
    await sftpFastPut(client, local, remote)
    return {
      ok: true,
      hostId,
      host: rec.meta.host,
      username,
      privateKeyPath: keyPath,
      localPath: local,
      remotePath: remote,
      bytes: st.size
    }
  } finally {
    client.end()
  }
}

function removeHost(id) {
  const dir = join(HOSTS, id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  const idx = readJson(INDEX, { version: 1, hosts: [] })
  idx.hosts = (idx.hosts || []).filter((h) => h.id !== id)
  writeJson(INDEX, idx)
  return true
}

const TOOLS = [
  {
    name: 'list_hosts',
    description: 'List host inventory entries',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_host',
    description: 'Get full host profile by id',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'search_hosts',
    description: 'Search hosts by service name, tags, notes',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'upsert_host',
    description: 'Create or update a host profile',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        username: { type: 'string' },
        privateKeyPath: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        env: { type: 'string' },
        notesMarkdown: { type: 'string' },
        services: { type: 'array' }
      },
      required: ['title']
    }
  },
  {
    name: 'upsert_service',
    description: 'Upsert a service on a host',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string' },
        ports: { type: 'array', items: { type: 'number' } },
        notes: { type: 'string' }
      },
      required: ['hostId', 'name']
    }
  },
  {
    name: 'append_note',
    description: 'Append a dated note to host notes.md',
    inputSchema: {
      type: 'object',
      properties: { hostId: { type: 'string' }, note: { type: 'string' } },
      required: ['hostId', 'note']
    }
  },
  {
    name: 'ssh_test',
    description:
      'Test SSH key login to an inventory host (uses meta.privateKeyPath or AISS_SSH_KEY)',
    inputSchema: {
      type: 'object',
      properties: { hostId: { type: 'string' } },
      required: ['hostId']
    }
  },
  {
    name: 'ssh_exec',
    description:
      'Run a remote command on an inventory host via SSH private key (no password)',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string' },
        command: { type: 'string', description: 'Shell command to run remotely' }
      },
      required: ['hostId', 'command']
    }
  },
  {
    name: 'ssh_upload',
    description:
      'Upload a local file to an inventory host via SFTP (ssh2 key auth). remotePath may end with / to keep the local filename.',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string' },
        localPath: { type: 'string', description: 'Absolute or relative path on this machine' },
        remotePath: {
          type: 'string',
          description: 'Remote file path, or directory ending with /'
        },
        mkdirParents: {
          type: 'boolean',
          description: 'Create remote parent dirs with mkdir -p (default true)'
        }
      },
      required: ['hostId', 'localPath', 'remotePath']
    }
  }
]

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_hosts':
      return listHosts()
    case 'get_host':
      return getHost(args.id)
    case 'search_hosts':
      return searchHosts(args.query)
    case 'upsert_host':
      return upsertHost(args)
    case 'upsert_service':
      return upsertService(args.hostId, {
        name: args.name,
        kind: args.kind || 'unknown',
        ports: args.ports,
        notes: args.notes
      })
    case 'append_note':
      return appendNote(args.hostId, args.note)
    case 'remove_host':
      return removeHost(args.id)
    case 'ssh_test':
      return sshTestHost(args.hostId)
    case 'ssh_exec':
      return sshExecOnHost(args.hostId, args.command)
    case 'ssh_upload':
      return sshUpload(args.hostId, args.localPath, args.remotePath, {
        mkdirParents: args.mkdirParents
      })
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// CLI mode
const argv = process.argv.slice(2)
if (argv.includes('--list')) {
  console.log(JSON.stringify({ root: ROOT, hosts: listHosts() }, null, 2))
  process.exit(0)
}
if (argv[0] === '--get' && argv[1]) {
  console.log(JSON.stringify(getHost(argv[1]), null, 2))
  process.exit(0)
}
if (argv[0] === '--search' && argv[1]) {
  console.log(JSON.stringify(searchHosts(argv[1]), null, 2))
  process.exit(0)
}
if (argv[0] === '--upload' && argv[1] && argv[2] && argv[3]) {
  sshUpload(argv[1], argv[2], argv[3])
    .then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(0)
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    })
} else if (argv[0] === '--exec' && argv[1] && argv[2]) {
  const hostId = argv[1]
  const command = argv.slice(2).join(' ')
  sshExecOnHost(hostId, command)
    .then((r) => {
      if (r.stdout) process.stdout.write(r.stdout)
      if (r.stderr) process.stderr.write(r.stderr)
      process.exit(r.code === 0 ? 0 : r.code || 1)
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    })
} else if (argv.includes('--help')) {
  console.log(`Inventory root: ${ROOT}
CLI: --list | --get <id> | --search <q> | --upload <hostId> <local> <remote> | --exec <hostId> <command>
MCP tools: list/get/search/upsert + ssh_test/ssh_exec/ssh_upload
`)
  process.exit(0)
} else {
// Minimal MCP-ish stdio JSON-RPC (compatible enough for simple clients)
ensure()
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })

function reply(id, result) {
  const msg = { jsonrpc: '2.0', id, result }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function replyError(id, message) {
  const msg = { jsonrpc: '2.0', id, error: { code: -32000, message } }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', async (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'ai-ssh-inventory', version: '0.3.0' },
        capabilities: { tools: {} }
      })
      return
    }
    if (method === 'notifications/initialized' || method === 'initialized') return
    if (method === 'tools/list') {
      reply(id, { tools: TOOLS })
      return
    }
    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments || {}
      const result = await callTool(name, args)
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      })
      return
    }
    if (method === 'ping') {
      reply(id, {})
      return
    }
    replyError(id, `Method not found: ${method}`)
  } catch (e) {
    replyError(id, e instanceof Error ? e.message : String(e))
  }
})

process.stderr.write(`[ai-ssh-inventory] ready root=${ROOT} key=${DEFAULT_SSH_KEY}\n`)
}