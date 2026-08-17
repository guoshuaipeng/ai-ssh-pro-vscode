import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { Client, type SFTPWrapper, type TransferOptions } from 'ssh2'
import type { SftpListEntry, SftpListResult } from '../shared/ipc'

/** 远端路径用 POSIX 风格拼接，避免 Windows 反斜杠污染 */
export function joinRemotePath(...parts: string[]): string {
  const cleaned = parts
    .map((p) => String(p ?? '').replace(/\\/g, '/'))
    .filter((p) => p.length > 0)
  if (cleaned.length === 0) return '/'
  let result = cleaned[0]!
  for (let i = 1; i < cleaned.length; i++) {
    const seg = cleaned[i]!.replace(/^\/+/, '')
    if (!seg) continue
    result = result.replace(/\/+$/, '') + '/' + seg
  }
  if (!result.startsWith('/')) result = '/' + result
  return result.replace(/\/{2,}/g, '/') || '/'
}

function normalizeRemotePath(remotePath: string): string {
  const p = String(remotePath ?? '').replace(/\\/g, '/').trim() || '/'
  if (p === '/') return '/'
  return p.replace(/\/+$/, '') || '/'
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err || !sftp) {
        reject(err ?? new Error('无法打开 SFTP'))
        return
      }
      resolve(sftp)
    })
  })
}

function withSftp<T>(client: Client, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return getSftp(client).then(async (sftp) => {
    try {
      return await fn(sftp)
    } finally {
      try {
        sftp.end()
      } catch {
        /* ignore */
      }
    }
  })
}

function entryToListItem(
  parentPath: string,
  entry: { filename: string; attrs: { size?: number; mtime?: number; isDirectory?: () => boolean } }
): SftpListEntry | null {
  const name = entry.filename
  if (!name || name === '.' || name === '..') return null
  const attrs = entry.attrs
  const isDirectory = Boolean(attrs && typeof attrs.isDirectory === 'function' && attrs.isDirectory())
  const size = typeof attrs?.size === 'number' ? attrs.size : 0
  const modifyTime = typeof attrs?.mtime === 'number' ? attrs.mtime * 1000 : undefined
  return {
    name,
    path: joinRemotePath(parentPath, name),
    isDirectory,
    size,
    modifyTime
  }
}

export async function list(client: Client, remotePath: string): Promise<SftpListResult> {
  const path = normalizeRemotePath(remotePath)
  return withSftp(client, (sftp) => {
    return new Promise<SftpListResult>((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) {
          reject(err)
          return
        }
        const entries: SftpListEntry[] = []
        for (const item of list ?? []) {
          const mapped = entryToListItem(path, item)
          if (mapped) entries.push(mapped)
        }
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
        resolve({ path, entries })
      })
    })
  })
}

/** 当前会话家目录（realpath('.')） */
export async function home(client: Client): Promise<string> {
  return withSftp(client, (sftp) => {
    return new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, abs) => {
        if (err || !abs) {
          reject(err ?? new Error('无法解析家目录'))
          return
        }
        resolve(normalizeRemotePath(abs))
      })
    })
  })
}

export type TransferProgress = {
  transferred: number
  total: number
}

function transferOpts(onProgress?: (p: TransferProgress) => void): TransferOptions | undefined {
  if (!onProgress) return undefined
  return {
    step: (totalTransferred: number, _chunk: number, total: number) => {
      onProgress({
        transferred: totalTransferred,
        total: total > 0 ? total : totalTransferred
      })
    }
  }
}

export async function download(
  client: Client,
  remotePath: string,
  localPath: string,
  onProgress?: (p: TransferProgress) => void
): Promise<void> {
  const remote = normalizeRemotePath(remotePath)
  await withSftp(client, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error | null) => (err ? reject(err) : resolve())
      const opts = transferOpts(onProgress)
      if (opts) sftp.fastGet(remote, localPath, opts, done)
      else sftp.fastGet(remote, localPath, done)
    })
  })
}

export async function upload(
  client: Client,
  localPath: string,
  remotePath: string,
  onProgress?: (p: TransferProgress) => void
): Promise<void> {
  const remote = normalizeRemotePath(remotePath)
  if (!existsSync(localPath)) {
    throw new Error(`本地文件不存在: ${localPath}`)
  }
  await withSftp(client, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error | null) => (err ? reject(err) : resolve())
      const opts = transferOpts(onProgress)
      if (opts) sftp.fastPut(localPath, remote, opts, done)
      else sftp.fastPut(localPath, remote, done)
    })
  })
}

export async function mkdir(client: Client, remotePath: string): Promise<void> {
  const path = normalizeRemotePath(remotePath)
  await withSftp(client, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })
}

export async function remove(client: Client, remotePath: string): Promise<void> {
  const path = normalizeRemotePath(remotePath)
  await withSftp(client, async (sftp) => {
    const attrs = await new Promise<{ isDirectory: () => boolean } | null>((resolve, reject) => {
      sftp.stat(path, (err, stats) => {
        if (err) reject(err)
        else resolve(stats ?? null)
      })
    })
    if (attrs && typeof attrs.isDirectory === 'function' && attrs.isDirectory()) {
      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(path, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  })
}

/** 与 remove 相同（文件 unlink / 空目录 rmdir） */
export const unlink = remove

export async function rename(client: Client, fromPath: string, toPath: string): Promise<void> {
  const from = normalizeRemotePath(fromPath)
  const to = normalizeRemotePath(toPath)
  await withSftp(client, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })
}

/** 上传时若只给了目录，拼上本地文件名 */
export function resolveUploadRemotePath(localPath: string, remotePath: string): string {
  const remote = String(remotePath ?? '').replace(/\\/g, '/').trim()
  if (!remote || remote.endsWith('/')) {
    return joinRemotePath(remote || '/', basename(localPath))
  }
  return normalizeRemotePath(remote)
}

const DEFAULT_TEXT_MAX = 2 * 1024 * 1024

export type SftpReadTextResult = {
  path: string
  content: string
  size: number
  truncated: boolean
  encoding: 'utf-8'
}

/** 读取远端文本（UTF-8）；含 NUL 则视为二进制拒绝 */
export async function readText(
  client: Client,
  remotePath: string,
  maxBytes = DEFAULT_TEXT_MAX
): Promise<SftpReadTextResult> {
  const path = normalizeRemotePath(remotePath)
  return withSftp(client, async (sftp) => {
    const size = await new Promise<number>((resolve, reject) => {
      sftp.stat(path, (err, st) => {
        if (err || !st) {
          reject(err ?? new Error('无法获取文件信息'))
          return
        }
        if (typeof st.isDirectory === 'function' && st.isDirectory()) {
          reject(new Error('不能打开目录'))
          return
        }
        resolve(typeof st.size === 'number' ? st.size : 0)
      })
    })

    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let got = 0
      const end = Math.max(0, Math.min(size > 0 ? size : maxBytes, maxBytes) - 1)
      const stream = sftp.createReadStream(path, {
        start: 0,
        end
      })
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        got += chunk.length
        if (got >= maxBytes) {
          try {
            stream.destroy()
          } catch {
            /* ignore */
          }
        }
      })
      stream.on('error', reject)
      stream.on('close', () => resolve(Buffer.concat(chunks)))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })

    if (buf.includes(0)) {
      throw new Error('该文件疑似二进制，不适合文本预览/编辑')
    }

    const content = buf.toString('utf8')
    return {
      path,
      content,
      size,
      truncated: size > buf.length,
      encoding: 'utf-8'
    }
  })
}

/** 将 UTF-8 文本写回远端（整文件覆盖） */
export async function writeText(client: Client, remotePath: string, content: string): Promise<void> {
  const path = normalizeRemotePath(remotePath)
  const data = Buffer.from(content ?? '', 'utf8')
  await withSftp(client, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path, { flags: 'w', mode: 0o644 })
      stream.on('error', reject)
      stream.on('close', () => resolve())
      stream.end(data)
    })
  })
}
