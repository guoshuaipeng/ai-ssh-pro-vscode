export type HostKeyDecision = { accept: boolean; alwaysTrust?: boolean }

export type HostKeyPromptRequest = {
  host: string
  port: number
  fingerprint: string
  reason: 'unknown' | 'changed'
  previousFingerprint?: string
}

type PromptHandler = (req: HostKeyPromptRequest) => Promise<HostKeyDecision>

let promptHandler: PromptHandler | null = null

export function setHostKeyPromptHandler(handler: PromptHandler | null): void {
  promptHandler = handler
}

export async function promptHostKey(req: HostKeyPromptRequest): Promise<HostKeyDecision> {
  if (!promptHandler) {
    return { accept: false, alwaysTrust: false }
  }
  try {
    return await promptHandler(req)
  } catch {
    return { accept: false, alwaysTrust: false }
  }
}
