import type { Client } from 'ssh2'
import type {
  DockerComposeProject,
  DockerComposeService,
  DockerContainer,
  DockerContainerAction,
  DockerContainerDetail,
  DockerContainerSwarmInfo,
  DockerComposeAction,
  DockerKeyValue,
  DockerMount,
  DockerNetworkInfo,
  DockerPortBinding,
  DockerSwarmAction,
  DockerSwarmInfo,
  DockerSwarmPort,
  DockerSwarmResources,
  DockerSwarmService,
  DockerSwarmServiceDetail,
  DockerSwarmStack,
  DockerSwarmTask,
  DockerTreeResult
} from '../shared/ipc'

export type ExecResult = {
  code: number
  stdout: string
  stderr: string
}

export function sshExec(client: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      stream.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      stream.on('close', (code: number | null) => {
        resolve({ code: code ?? 0, stdout, stderr })
      })
    })
  })
}

/** 仅允许 docker 容器 id / 名称中的安全字符 */
export function assertSafeDockerId(id: string, label = 'id'): string {
  const s = String(id || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(s)) {
    throw new Error(`非法 Docker ${label}`)
  }
  return s
}

function assertSafeComposeProject(name: string): string {
  return assertSafeDockerId(name, 'compose 项目名')
}

function trimErr(stdout: string, stderr: string, code: number): string {
  const msg = (stderr || stdout || `exit ${code}`).trim()
  return msg.slice(0, 800)
}

function parseJsonLines(text: string): unknown[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const out: unknown[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip bad line */
    }
  }
  return out
}

function parseJsonArrayOrLines(text: string): unknown[] {
  const t = text.trim()
  if (!t) return []
  try {
    const parsed = JSON.parse(t) as unknown
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') return [parsed]
  } catch {
    /* fall through to ndjson */
  }
  return parseJsonLines(t)
}

function shortStatus(state: string, status: string): string {
  const st = status.toLowerCase()
  const stt = state.toLowerCase()
  if (/\(health:\s*starting\)|\bhealth:\s*starting\b/.test(st)) return 'starting'
  if (/\bunhealthy\b/.test(st)) return 'unhealthy'
  if (/\bhealthy\b/.test(st)) return 'healthy'
  if (stt === 'restarting' || /\brestarting\b/.test(st)) return 'starting'
  if (stt === 'created' || stt === 'starting') return 'starting'
  if (stt === 'running') return 'running'
  if (stt === 'exited') return 'exited'
  if (stt === 'paused') return 'paused'
  if (state) return state
  return status.slice(0, 32) || 'unknown'
}

function parseLabelMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  }
  if (typeof raw !== 'string' || !raw.trim()) return out
  // docker ps --format json: "k=v,k2=v2" (values may contain =)
  for (const part of raw.split(',')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function mapContainer(raw: Record<string, unknown>): DockerContainer | null {
  const id = typeof raw.ID === 'string' ? raw.ID : typeof raw.Id === 'string' ? raw.Id : ''
  if (!id) return null
  const namesRaw = typeof raw.Names === 'string' ? raw.Names : typeof raw.Name === 'string' ? raw.Name : ''
  const name = namesRaw.replace(/^\//, '').split(',')[0]?.trim() || id.slice(0, 12)
  const image = typeof raw.Image === 'string' ? raw.Image : ''
  const state = typeof raw.State === 'string' ? raw.State : ''
  const status = typeof raw.Status === 'string' ? raw.Status : state
  const ports = typeof raw.Ports === 'string' ? raw.Ports : ''
  const createdAt = typeof raw.CreatedAt === 'string' ? raw.CreatedAt : undefined
  const labels = parseLabelMap(raw.Labels)
  const composeProject = labels['com.docker.compose.project']?.trim() || undefined
  const composeService = labels['com.docker.compose.service']?.trim() || undefined
  const swarmService = labels['com.docker.swarm.service.name']?.trim() || undefined
  return {
    id,
    name,
    image,
    state,
    status,
    shortStatus: shortStatus(state, status),
    ports,
    createdAt,
    ...(composeProject ? { composeProject } : {}),
    ...(composeService ? { composeService } : {}),
    ...(swarmService ? { swarmService } : {})
  }
}

export async function listContainers(client: Client): Promise<{ containers: DockerContainer[]; error?: string }> {
  const r = await sshExec(client, `docker ps -a --format '{{json .}}'`)
  if (r.code !== 0) {
    return { containers: [], error: trimErr(r.stdout, r.stderr, r.code) }
  }
  const containers = parseJsonLines(r.stdout)
    .map((x) => (x && typeof x === 'object' ? mapContainer(x as Record<string, unknown>) : null))
    .filter(Boolean) as DockerContainer[]
  return { containers }
}

export async function listComposeProjects(
  client: Client
): Promise<{ projects: DockerComposeProject[]; error?: string }> {
  const r = await sshExec(client, 'docker compose ls --format json')
  if (r.code !== 0) {
    const fallback = await sshExec(client, 'docker-compose ls --format json')
    if (fallback.code !== 0) {
      return { projects: [], error: trimErr(r.stdout, r.stderr, r.code) }
    }
    return { projects: mapComposeProjects(fallback.stdout) }
  }
  return { projects: mapComposeProjects(r.stdout) }
}

function mapComposeProjects(stdout: string): DockerComposeProject[] {
  return parseJsonArrayOrLines(stdout)
    .map((x) => {
      if (!x || typeof x !== 'object') return null
      const o = x as Record<string, unknown>
      const name = typeof o.Name === 'string' ? o.Name.trim() : ''
      if (!name) return null
      const status = typeof o.Status === 'string' ? o.Status : undefined
      const configFiles = typeof o.ConfigFiles === 'string' ? o.ConfigFiles : undefined
      return { name, status, configFiles, containers: [] } satisfies DockerComposeProject
    })
    .filter(Boolean) as DockerComposeProject[]
}

const STACK_LABEL = 'com.docker.stack.namespace'

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** docker 的时长字段是纳秒 */
function fromNanos(v: unknown): string | undefined {
  const n = num(v)
  if (!n || n <= 0) return undefined
  const sec = n / 1e9
  if (sec < 1) return `${Math.round(sec * 1000)}ms`
  if (sec < 60) return `${Number(sec.toFixed(sec < 10 ? 1 : 0))}s`
  return `${Number((sec / 60).toFixed(1))}min`
}

function formatBytes(v: unknown): string | undefined {
  const n = num(v)
  if (!n || n <= 0) return undefined
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = n
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${Number(x.toFixed(x < 10 && i > 0 ? 1 : 0))}${units[i]}`
}

function parseReplicas(replicas: string): { running: number; desired: number } {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(replicas.trim())
  if (!m) return { running: 0, desired: 0 }
  return { running: Number(m[1]), desired: Number(m[2]) }
}

function swarmShortStatus(running: number, desired: number): string {
  if (desired === 0) return 'exited'
  if (running === 0) return 'exited'
  if (running < desired) return 'starting'
  return 'running'
}

function mapSwarmPorts(raw: unknown): DockerSwarmPort[] {
  if (!Array.isArray(raw)) return []
  const out: DockerSwarmPort[] = []
  for (const item of raw) {
    const p = obj(item)
    const target = num(p.TargetPort)
    if (target === undefined) continue
    out.push({
      targetPort: target,
      publishedPort: num(p.PublishedPort),
      protocol: str(p.Protocol) || 'tcp',
      publishMode: str(p.PublishMode) || 'ingress'
    })
  }
  return out.sort((a, b) => (a.publishedPort ?? a.targetPort) - (b.publishedPort ?? b.targetPort))
}

/** service inspect 里的网络是 ID，换成可读名字 */
async function networkNameMap(client: Client): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const r = await sshExec(client, `docker network ls --no-trunc --format '{{.ID}} {{.Name}}'`)
  if (r.code !== 0) return map
  for (const line of r.stdout.split(/\r?\n/)) {
    const [id, ...rest] = line.trim().split(/\s+/)
    const name = rest.join(' ')
    if (id && name) map.set(id, name)
  }
  return map
}

function resolveNetworkName(map: Map<string, string>, id: string): string {
  const direct = map.get(id)
  if (direct) return direct
  // overlay 用 25 位 swarm ID，本地网络用 64 位 ID，按前缀兜底匹配
  if (id.length >= 12) {
    for (const [key, name] of map) {
      if (key.startsWith(id) || id.startsWith(key)) return name
    }
  }
  return id
}

async function getSwarmState(client: Client): Promise<{ active: boolean; manager: boolean }> {
  const r = await sshExec(
    client,
    `docker info --format '{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}'`
  )
  if (r.code !== 0) return { active: false, manager: false }
  const [state, control] = r.stdout.trim().split('|')
  return { active: (state || '').trim() === 'active', manager: (control || '').trim() === 'true' }
}

export async function listSwarmServices(client: Client): Promise<DockerSwarmInfo> {
  const state = await getSwarmState(client)
  if (!state.active) return { active: false, manager: false, stacks: [] }
  if (!state.manager) {
    return {
      active: true,
      manager: false,
      stacks: [],
      error: '本节点是 Swarm worker，只有 manager 节点可以查看服务配置'
    }
  }

  const [ls, inspect] = await Promise.all([
    sshExec(client, `docker service ls --format '{{json .}}'`),
    // 无服务时 docker service inspect 不带参数会报错，这里先判空
    sshExec(
      client,
      `ids=$(docker service ls -q); if [ -n "$ids" ]; then docker service inspect $ids --format '{{json .}}'; fi`
    )
  ])
  if (ls.code !== 0) {
    return { active: true, manager: true, stacks: [], error: trimErr(ls.stdout, ls.stderr, ls.code) }
  }

  // service ls 有现成的副本数，service inspect 有结构化端口和标签，按 ID 合并
  const detailById = new Map<string, Record<string, unknown>>()
  for (const item of parseJsonLines(inspect.stdout)) {
    const o = obj(item)
    const id = str(o.ID)
    if (id) detailById.set(id, o)
  }

  const services: DockerSwarmService[] = []
  for (const item of parseJsonLines(ls.stdout)) {
    const o = obj(item)
    const id = str(o.ID)
    const name = str(o.Name)
    if (!id || !name) continue
    const replicas = str(o.Replicas)
    const { running, desired } = parseReplicas(replicas)
    const detail = detailById.get(id)
    const spec = obj(detail?.Spec)
    const labels = parseLabelMap(spec.Labels)
    const endpoint = obj(detail?.Endpoint)
    const ports = mapSwarmPorts(endpoint.Ports ?? obj(spec.EndpointSpec).Ports)
    const stack = labels[STACK_LABEL]?.trim() || undefined
    services.push({
      id,
      name,
      image: str(o.Image),
      mode: str(o.Mode) || 'replicated',
      replicas,
      runningTasks: running,
      desiredTasks: desired,
      shortStatus: swarmShortStatus(running, desired),
      ports,
      containers: [],
      ...(stack ? { stack } : {})
    })
  }

  const byStack = new Map<string, DockerSwarmService[]>()
  for (const svc of services) {
    const key = svc.stack ?? ''
    const list = byStack.get(key) ?? []
    list.push(svc)
    byStack.set(key, list)
  }
  const stacks: DockerSwarmStack[] = [...byStack.entries()]
    .map(([name, list]) => ({
      name,
      services: list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }))
    // 未归属 stack 的服务排在最后
    .sort((a, b) => {
      if (!a.name) return 1
      if (!b.name) return -1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })

  return { active: true, manager: true, stacks }
}

function mapSwarmTasks(stdout: string): DockerSwarmTask[] {
  return parseJsonLines(stdout)
    .map((x) => {
      const o = obj(x)
      const id = str(o.ID)
      if (!id) return null
      const currentState = str(o.CurrentState)
      const desiredState = str(o.DesiredState)
      const err = str(o.Error).trim()
      return {
        id,
        name: str(o.Name) || id,
        node: str(o.Node) || undefined,
        image: str(o.Image) || undefined,
        currentState,
        desiredState,
        shortStatus: shortStatus(currentState.split(' ')[0] || '', currentState),
        ...(err ? { error: err } : {})
      } satisfies DockerSwarmTask
    })
    .filter(Boolean) as DockerSwarmTask[]
}

function parseSwarmResources(resources: Record<string, unknown>): DockerSwarmResources | undefined {
  const limits = obj(resources.Limits)
  const reservations = obj(resources.Reservations)
  const cpu = (v: unknown): string | undefined => {
    const n = num(v)
    return n && n > 0 ? `${n / 1e9}` : undefined
  }
  const out: DockerSwarmResources = {
    limitCpu: cpu(limits.NanoCPUs),
    limitMemory: formatBytes(limits.MemoryBytes),
    reserveCpu: cpu(reservations.NanoCPUs),
    reserveMemory: formatBytes(reservations.MemoryBytes)
  }
  return Object.values(out).some(Boolean) ? out : undefined
}

function describeUpdatePolicy(updateConfig: Record<string, unknown>): string | undefined {
  const parts: string[] = []
  const parallelism = num(updateConfig.Parallelism)
  if (parallelism !== undefined) parts.push(`并行 ${parallelism}`)
  const delay = fromNanos(updateConfig.Delay)
  if (delay) parts.push(`间隔 ${delay}`)
  const order = str(updateConfig.Order)
  if (order) parts.push(`顺序 ${order}`)
  const failure = str(updateConfig.FailureAction)
  if (failure) parts.push(`失败 ${failure}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function describeRestartPolicy(policy: Record<string, unknown>): string | undefined {
  const condition = str(policy.Condition)
  if (!condition) return undefined
  const parts = [condition]
  const delay = fromNanos(policy.Delay)
  if (delay) parts.push(`延迟 ${delay}`)
  const max = num(policy.MaxAttempts)
  if (max) parts.push(`最多 ${max} 次`)
  return parts.join(' · ')
}

function describeHealthcheck(healthcheck: Record<string, unknown>): string | undefined {
  const test = Array.isArray(healthcheck.Test)
    ? healthcheck.Test.filter((x): x is string => typeof x === 'string')
    : []
  if (test.length === 0) return undefined
  // Test[0] 是 CMD / CMD-SHELL / NONE
  if (test[0] === 'NONE') return undefined
  const cmd = test.slice(1).join(' ')
  const bits: string[] = [cmd || test.join(' ')]
  const interval = fromNanos(healthcheck.Interval)
  if (interval) bits.push(`间隔 ${interval}`)
  const timeout = fromNanos(healthcheck.Timeout)
  if (timeout) bits.push(`超时 ${timeout}`)
  const retries = num(healthcheck.Retries)
  if (retries) bits.push(`重试 ${retries}`)
  return bits.join(' · ')
}

function mapSwarmMounts(raw: unknown): DockerMount[] {
  if (!Array.isArray(raw)) return []
  return raw.map((m) => {
    const mount = obj(m)
    return {
      type: str(mount.Type) || 'bind',
      source: str(mount.Source),
      destination: str(mount.Target),
      readWrite: mount.ReadOnly !== true
    } satisfies DockerMount
  })
}

export async function inspectSwarmService(
  client: Client,
  service: string
): Promise<DockerSwarmServiceDetail> {
  const name = assertSafeDockerId(service, 'Swarm 服务')
  const [inspect, ps, netMap] = await Promise.all([
    sshExec(client, `docker service inspect ${name} --format '{{json .}}'`),
    sshExec(client, `docker service ps ${name} --no-trunc --format '{{json .}}'`),
    networkNameMap(client)
  ])
  if (inspect.code !== 0) throw new Error(trimErr(inspect.stdout, inspect.stderr, inspect.code))

  let parsed: unknown
  try {
    parsed = JSON.parse(inspect.stdout.trim())
  } catch {
    throw new Error('无法解析 docker service inspect 输出')
  }
  const root = obj(Array.isArray(parsed) ? parsed[0] : parsed)
  const spec = obj(root.Spec)
  const taskTemplate = obj(spec.TaskTemplate)
  const containerSpec = obj(taskTemplate.ContainerSpec)
  const mode = obj(spec.Mode)
  const replicated = obj(mode.Replicated)
  const desired = num(replicated.Replicas) ?? 0
  const isGlobal = Boolean(mode.Global)

  const tasks = mapSwarmTasks(ps.stdout)
  const running = tasks.filter(
    (t) => t.desiredState === 'Running' && /^running/i.test(t.currentState)
  ).length

  const networksRaw = Array.isArray(taskTemplate.Networks)
    ? taskTemplate.Networks
    : Array.isArray(spec.Networks)
      ? spec.Networks
      : []
  const networks = networksRaw
    .map((n) => str(obj(n).Target))
    .filter(Boolean)
    .map((id) => resolveNetworkName(netMap, id))

  const command = [
    ...(Array.isArray(containerSpec.Command) ? containerSpec.Command : []),
    ...(Array.isArray(containerSpec.Args) ? containerSpec.Args : [])
  ]
    .filter((x): x is string => typeof x === 'string')
    .join(' ')

  const labels = parseLabelMap(spec.Labels)
  const stack = labels[STACK_LABEL]?.trim() || undefined

  return {
    id: str(root.ID) || name,
    name: str(spec.Name) || name,
    image: str(containerSpec.Image),
    mode: isGlobal ? 'global' : 'replicated',
    replicas: isGlobal ? `${running}/${tasks.filter((t) => t.desiredState === 'Running').length}` : `${running}/${desired}`,
    stack,
    createdAt: str(root.CreatedAt) || undefined,
    updatedAt: str(root.UpdatedAt) || undefined,
    command: command || undefined,
    user: str(containerSpec.User) || undefined,
    workingDir: str(containerSpec.Dir) || undefined,
    ports: mapSwarmPorts(obj(root.Endpoint).Ports ?? obj(spec.EndpointSpec).Ports),
    env: (Array.isArray(containerSpec.Env) ? containerSpec.Env : [])
      .filter((x): x is string => typeof x === 'string')
      .map(splitEnvEntry),
    mounts: mapSwarmMounts(containerSpec.Mounts),
    networks,
    labels: Object.entries(labels).map(([key, value]) => ({ key, value })),
    containerLabels: Object.entries(parseLabelMap(containerSpec.Labels)).map(([key, value]) => ({
      key,
      value
    })),
    constraints: (Array.isArray(obj(taskTemplate.Placement).Constraints)
      ? (obj(taskTemplate.Placement).Constraints as unknown[])
      : []
    ).filter((x): x is string => typeof x === 'string'),
    hosts: (Array.isArray(containerSpec.Hosts) ? containerSpec.Hosts : []).filter(
      (x): x is string => typeof x === 'string'
    ),
    resources: parseSwarmResources(obj(taskTemplate.Resources)),
    updatePolicy: describeUpdatePolicy(obj(spec.UpdateConfig)),
    restartPolicy: describeRestartPolicy(obj(taskTemplate.RestartPolicy)),
    healthcheck: describeHealthcheck(obj(containerSpec.Healthcheck)),
    tasks: tasks.slice(0, 30)
  }
}

export async function swarmServiceLogs(
  client: Client,
  service: string,
  tail = 200
): Promise<string> {
  const name = assertSafeDockerId(service, 'Swarm 服务')
  const n = Math.min(2000, Math.max(20, Math.floor(tail) || 200))
  const r = await sshExec(client, `docker service logs --tail ${n} ${name} 2>&1`)
  if (r.code !== 0 && !r.stdout.trim()) {
    throw new Error(trimErr(r.stdout, r.stderr, r.code))
  }
  return (r.stdout || r.stderr || '').slice(-200_000)
}

export async function swarmServiceAction(
  client: Client,
  service: string,
  action: DockerSwarmAction,
  replicas?: number
): Promise<void> {
  const name = assertSafeDockerId(service, 'Swarm 服务')
  if (action === 'restart') {
    const r = await sshExec(client, `docker service update --force ${name}`)
    if (r.code !== 0) throw new Error(trimErr(r.stdout, r.stderr, r.code))
    return
  }
  if (action === 'scale') {
    const n = Math.floor(replicas ?? -1)
    if (!Number.isFinite(n) || n < 0 || n > 512) throw new Error('副本数需为 0–512 的整数')
    const r = await sshExec(client, `docker service scale ${name}=${n}`)
    if (r.code !== 0) throw new Error(trimErr(r.stdout, r.stderr, r.code))
    return
  }
  throw new Error(`不支持的 Swarm 操作: ${action}`)
}

export async function listTree(client: Client): Promise<DockerTreeResult> {
  const [c, p, swarm] = await Promise.all([
    listContainers(client),
    listComposeProjects(client),
    listSwarmServices(client).catch((e: unknown) => ({
      active: false,
      manager: false,
      stacks: [],
      error: e instanceof Error ? e.message : String(e)
    }))
  ])
  const byProject = new Map<string, DockerContainer[]>()
  const bySwarmService = new Map<string, DockerContainer[]>()
  const standalone: DockerContainer[] = []
  const swarmServiceNames = new Set(
    swarm.stacks.flatMap((s) => s.services.map((svc) => svc.name))
  )

  for (const container of c.containers) {
    const proj = container.composeProject?.trim()
    const svc = container.swarmService?.trim()
    if (proj) {
      const list = byProject.get(proj) ?? []
      list.push(container)
      byProject.set(proj, list)
    } else if (svc && swarmServiceNames.has(svc)) {
      // 归到 Swarm 分组下，避免同一个任务容器在树上出现两次
      const list = bySwarmService.get(svc) ?? []
      list.push(container)
      bySwarmService.set(svc, list)
    } else {
      standalone.push(container)
    }
  }

  for (const stack of swarm.stacks) {
    for (const service of stack.services) {
      service.containers = (bySwarmService.get(service.name) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, 'zh-Hans-CN')
      )
    }
  }

  const projects = [...p.projects]
  const known = new Set(projects.map((x) => x.name))
  for (const name of byProject.keys()) {
    if (!known.has(name)) {
      projects.push({ name, containers: [] })
      known.add(name)
    }
  }

  for (const project of projects) {
    project.containers = byProject.get(project.name) ?? []
  }

  projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  standalone.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return {
    containers: standalone,
    composeProjects: projects,
    swarm,
    containersError: c.error,
    composeError: p.error
  }
}

export async function containerAction(
  client: Client,
  containerId: string,
  action: DockerContainerAction
): Promise<void> {
  const id = assertSafeDockerId(containerId, '容器')

  // Swarm 任务：docker restart/start/stop 会打乱编排，常导致多实例残留
  const inspect = await sshExec(
    client,
    `docker inspect --format '{{index .Config.Labels "com.docker.swarm.service.name"}}' ${id}`
  )
  const swarmService = (inspect.stdout || '').trim()
  if (swarmService && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(swarmService)) {
    if (action === 'restart') {
      const r = await sshExec(client, `docker service update --force ${swarmService}`)
      if (r.code !== 0) throw new Error(trimErr(r.stdout, r.stderr, r.code))
      return
    }
    if (action === 'start' || action === 'stop' || action === 'rm') {
      throw new Error(
        `「${id}」属于 Swarm 服务「${swarmService}」。请勿直接 ${action} 任务容器（会导致多实例）。` +
          `重启请用「重启」按钮（service update --force）；停服可用：docker service scale ${swarmService}=0`
      )
    }
  }

  const cmd =
    action === 'start'
      ? `docker start ${id}`
      : action === 'stop'
        ? `docker stop ${id}`
        : action === 'restart'
          ? `docker restart ${id}`
          : action === 'rm'
            ? `docker rm -f ${id}`
            : null
  if (!cmd) throw new Error(`不支持的容器操作: ${action}`)
  const r = await sshExec(client, cmd)
  if (r.code !== 0) throw new Error(trimErr(r.stdout, r.stderr, r.code))
}

export async function containerLogs(
  client: Client,
  containerId: string,
  tail = 200
): Promise<string> {
  const id = assertSafeDockerId(containerId, '容器')
  const n = Math.min(2000, Math.max(20, Math.floor(tail) || 200))
  const r = await sshExec(client, `docker logs --tail ${n} ${id} 2>&1`)
  if (r.code !== 0 && !r.stdout.trim()) {
    throw new Error(trimErr(r.stdout, r.stderr, r.code))
  }
  return (r.stdout || r.stderr || '').slice(-200_000)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function splitEnvEntry(entry: string): DockerKeyValue {
  const i = entry.indexOf('=')
  if (i < 0) return { key: entry, value: '' }
  return { key: entry.slice(0, i), value: entry.slice(i + 1) }
}

function parseEnv(config: Record<string, unknown>): DockerKeyValue[] {
  const raw = Array.isArray(config.Env) ? config.Env : []
  return raw.filter((x): x is string => typeof x === 'string').map(splitEnvEntry)
}

function parsePorts(networkSettings: Record<string, unknown>): DockerPortBinding[] {
  const portMap = obj(networkSettings.Ports)
  const out: DockerPortBinding[] = []
  for (const [container, bindings] of Object.entries(portMap)) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      // 已 EXPOSE 但未映射到宿主机
      out.push({ container })
      continue
    }
    for (const b of bindings) {
      const bind = obj(b)
      out.push({
        container,
        hostIp: str(bind.HostIp) || undefined,
        hostPort: str(bind.HostPort) || undefined
      })
    }
  }
  return out.sort((a, b) => a.container.localeCompare(b.container, 'en'))
}

function parseMounts(raw: unknown): DockerMount[] {
  if (!Array.isArray(raw)) return []
  return raw.map((m) => {
    const mount = obj(m)
    return {
      type: str(mount.Type) || 'bind',
      source: str(mount.Source) || str(mount.Name),
      destination: str(mount.Destination),
      readWrite: mount.RW !== false
    } satisfies DockerMount
  })
}

function parseNetworks(networkSettings: Record<string, unknown>): DockerNetworkInfo[] {
  const nets = obj(networkSettings.Networks)
  return Object.entries(nets).map(([name, v]) => {
    const net = obj(v)
    return { name, ipAddress: str(net.IPAddress) || undefined }
  })
}

function parseRestartPolicy(hostConfig: Record<string, unknown>): string | undefined {
  const policy = obj(hostConfig.RestartPolicy)
  const name = str(policy.Name)
  if (!name || name === 'no') return name || undefined
  const max = typeof policy.MaximumRetryCount === 'number' ? policy.MaximumRetryCount : 0
  return name === 'on-failure' && max > 0 ? `${name}:${max}` : name
}

function joinCommand(config: Record<string, unknown>): string | undefined {
  const entrypoint = Array.isArray(config.Entrypoint) ? config.Entrypoint : []
  const cmd = Array.isArray(config.Cmd) ? config.Cmd : []
  const parts = [...entrypoint, ...cmd].filter((x): x is string => typeof x === 'string')
  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * Swarm 任务容器的端口发布在 service 上（ingress 由 routing mesh 转发），
 * 容器的 NetworkSettings.Ports 里只有 EXPOSE 的端口，所以要回到服务上取。
 */
async function swarmInfoForContainer(
  client: Client,
  labels: Record<string, string>
): Promise<DockerContainerSwarmInfo | undefined> {
  const service = labels['com.docker.swarm.service.name']?.trim()
  if (!service) return undefined
  const info: DockerContainerSwarmInfo = {
    service,
    taskName: labels['com.docker.swarm.task.name']?.trim() || undefined,
    publishedPorts: []
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service)) return info

  const r = await sshExec(client, `docker service inspect ${service} --format '{{json .Endpoint}}'`)
  if (r.code !== 0) {
    info.error = trimErr(r.stdout, r.stderr, r.code)
    return info
  }
  try {
    info.publishedPorts = mapSwarmPorts(obj(JSON.parse(r.stdout.trim())).Ports)
  } catch {
    info.error = '无法解析 docker service inspect 输出'
  }
  return info
}

export async function inspectContainer(
  client: Client,
  containerId: string
): Promise<DockerContainerDetail> {
  const id = assertSafeDockerId(containerId, '容器')
  const r = await sshExec(client, `docker inspect --format '{{json .}}' ${id}`)
  if (r.code !== 0) throw new Error(trimErr(r.stdout, r.stderr, r.code))

  let parsed: unknown
  try {
    parsed = JSON.parse(r.stdout.trim())
  } catch {
    throw new Error('无法解析 docker inspect 输出')
  }
  const root = obj(Array.isArray(parsed) ? parsed[0] : parsed)
  const config = obj(root.Config)
  const hostConfig = obj(root.HostConfig)
  const state = obj(root.State)
  const networkSettings = obj(root.NetworkSettings)
  const health = obj(state.Health)
  const labels = parseLabelMap(config.Labels)
  const swarm = await swarmInfoForContainer(client, labels)

  return {
    id: str(root.Id) || id,
    name: str(root.Name).replace(/^\//, '') || id,
    image: str(config.Image) || str(root.Image),
    command: joinCommand(config),
    workingDir: str(config.WorkingDir) || undefined,
    user: str(config.User) || undefined,
    restartPolicy: parseRestartPolicy(hostConfig),
    createdAt: str(root.Created) || undefined,
    startedAt: str(state.StartedAt) || undefined,
    finishedAt: str(state.FinishedAt) || undefined,
    exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : undefined,
    health: str(health.Status) || undefined,
    env: parseEnv(config),
    ports: parsePorts(networkSettings),
    mounts: parseMounts(root.Mounts),
    networks: parseNetworks(networkSettings),
    labels: Object.entries(labels).map(([key, value]) => ({ key, value })),
    ...(swarm ? { swarm } : {})
  }
}

export async function composePs(
  client: Client,
  project: string
): Promise<{ services: DockerComposeService[]; error?: string }> {
  const name = assertSafeComposeProject(project)
  const r = await sshExec(client, `docker compose -p ${name} ps -a --format '{{json .}}'`)
  if (r.code !== 0) {
    return { services: [], error: trimErr(r.stdout, r.stderr, r.code) }
  }
  const services = parseJsonLines(r.stdout)
    .map((x) => {
      if (!x || typeof x !== 'object') return null
      const o = x as Record<string, unknown>
      const svc =
        typeof o.Service === 'string'
          ? o.Service
          : typeof o.Name === 'string'
            ? o.Name
            : typeof o.Names === 'string'
              ? o.Names.replace(/^\//, '').split(',')[0] || ''
              : ''
      const id = typeof o.ID === 'string' ? o.ID : typeof o.Id === 'string' ? o.Id : undefined
      const state = typeof o.State === 'string' ? o.State : typeof o.Status === 'string' ? o.Status : ''
      const status = typeof o.Status === 'string' ? o.Status : state
      if (!svc && !id) return null
      return {
        name: svc || id || '?',
        id,
        state,
        status,
        shortStatus: shortStatus(state, status)
      } satisfies DockerComposeService
    })
    .filter(Boolean) as DockerComposeService[]
  return { services }
}

export async function composeAction(
  client: Client,
  project: string,
  action: DockerComposeAction
): Promise<void> {
  const name = assertSafeComposeProject(project)
  const cmd =
    action === 'up'
      ? `docker compose -p ${name} up -d`
      : action === 'down'
        ? `docker compose -p ${name} down`
        : null
  if (!cmd) throw new Error(`不支持的 compose 操作: ${action}`)
  const r = await sshExec(client, cmd)
  if (r.code !== 0) throw new Error(trimErr(r.stdout, r.stderr, r.code))
}
