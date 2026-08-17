import net from 'node:net'
import type { Client } from 'ssh2'
import type { LocalPortForward } from '../shared/ipc'

/**
 * 在 127.0.0.1:localPort 上监听，经 SSH `forwardOut` 转到远端 remoteHost:remotePort。
 * 返回清理函数（关闭 server 与已建立的本地连接）。
 */
export function startLocalPortForwards(
  client: Client,
  forwards: LocalPortForward[]
): Array<() => void> {
  const cleanups: Array<() => void> = []
  for (const fwd of forwards) {
    try {
      cleanups.push(startOneForward(client, fwd))
    } catch (e) {
      console.error('[port-forward] failed to start', fwd, e)
    }
  }
  return cleanups
}

function startOneForward(client: Client, fwd: LocalPortForward): () => void {
  const localPort = Math.floor(Number(fwd.localPort))
  const remotePort = Math.floor(Number(fwd.remotePort))
  const remoteHost = String(fwd.remoteHost || '').trim()
  if (!Number.isFinite(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error(`无效的本地端口: ${fwd.localPort}`)
  }
  if (!Number.isFinite(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error(`无效的远端端口: ${fwd.remotePort}`)
  }
  if (!remoteHost) {
    throw new Error('远端主机不能为空')
  }

  const sockets = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })

    const srcIp = socket.remoteAddress || '127.0.0.1'
    const srcPort = typeof socket.remotePort === 'number' ? socket.remotePort : 0

    try {
      client.forwardOut(srcIp, srcPort, remoteHost, remotePort, (err, stream) => {
        if (err || !stream) {
          console.error('[port-forward] forwardOut failed:', err?.message ?? 'no stream')
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
          return
        }

        stream.on('error', () => {
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
        })
        socket.on('error', () => {
          try {
            stream.close()
          } catch {
            /* ignore */
          }
        })

        socket.pipe(stream)
        stream.pipe(socket)
      })
    } catch (e) {
      console.error('[port-forward] forwardOut threw:', e)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
  })

  server.on('error', (err) => {
    console.error(`[port-forward] listen ${localPort} error:`, err.message)
  })

  server.listen(localPort, '127.0.0.1')

  return () => {
    for (const s of sockets) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    sockets.clear()
    try {
      server.close()
    } catch {
      /* ignore */
    }
  }
}
