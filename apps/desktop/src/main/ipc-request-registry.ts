/**
 * Single ownership point for every in-flight desktop IPC request. Main never
 * hands request Promises to preload or renderer code; the registry settles,
 * times out, aborts, and generation/renderer-scopes them in one place.
 */

import { DesktopTransportError } from '@deepseek-ai/dsh-client-connection-desktop/protocol'

export interface PendingRequest {
  readonly id: string
  readonly generation: number
  readonly createdAt: number
  readonly rendererId?: string
  resolve(value: unknown): void
  reject(error: Error): void
  timeout?: NodeJS.Timeout
  abortCleanup?: () => void
}

export interface RegisterRequestOptions {
  readonly id: string
  readonly generation: number
  readonly rendererId?: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Generate the standard timeout error for one pending desktop request. */
export function ipcTimeoutError(id: string, timeoutMs: number): DesktopTransportError {
  return new DesktopTransportError('request-timeout', `desktop request ${id} timed out after ${timeoutMs}ms`)
}

/**
 * Request-correlation registry used by the Harness process manager.
 * A request belongs to one host generation and, when renderer identity is
 * available, one renderer boot; bulk settlement scopes both dimensions.
 */
export class IpcRequestRegistry {
  private readonly pending = new Map<string, PendingRequest>()

  get size(): number {
    return this.pending.size
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  /** Track a request and install its timeout and abort cleanup. */
  register(options: RegisterRequestOptions): PendingRequest {
    if (this.pending.has(options.id)) {
      throw new Error(`desktop request registry already owns id ${options.id}`)
    }
    const request: PendingRequest = {
      id: options.id,
      generation: options.generation,
      createdAt: Date.now(),
      ...options.rendererId === undefined ? {} : { rendererId: options.rendererId },
      resolve: options.resolve,
      reject: options.reject,
    }
    const timeoutMs = options.timeoutMs
    if (timeoutMs !== undefined) {
      request.timeout = setTimeout(() => {
        this.abort(options.id, ipcTimeoutError(options.id, timeoutMs))
      }, timeoutMs)
    }
    const signal = options.signal
    if (signal !== undefined) {
      const onAbort = (): void => {
        this.reject(options.id, abortError(signal))
      }
      request.abortCleanup = () => {
        signal.removeEventListener('abort', onAbort)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
    this.pending.set(options.id, request)
    return request
  }

  /** Resolve one request; unknown/stale ids are ignored. */
  resolve(id: string, value: unknown): void {
    const request = this.take(id)
    if (request !== undefined) request.resolve(value)
  }

  /** Reject one request with a carrier error. */
  reject(id: string, error: Error): void {
    const request = this.take(id)
    if (request !== undefined) request.reject(error)
  }

  /** Abort one request with the standard `request-aborted` category. */
  abort(id: string, error = new DesktopTransportError('request-aborted', `desktop request ${id} was aborted`)): void {
    this.reject(id, error)
  }

  /** Reject every request belonging to one host generation. */
  rejectGeneration(generation: number, error: Error): void {
    for (const request of [...this.pending.values()]) {
      if (request.generation === generation) this.reject(request.id, error)
    }
  }

  /** Reject every request owned by one renderer boot. */
  rejectRenderer(rendererId: string, error: Error): void {
    for (const request of [...this.pending.values()]) {
      if (request.rendererId === rendererId) this.reject(request.id, error)
    }
  }

  /** Reject all pending requests; teardown uses this after intentional stop. */
  rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.reject(id, error)
  }

  private take(id: string): PendingRequest | undefined {
    const request = this.pending.get(id)
    if (request === undefined) return undefined
    if (request.timeout !== undefined) clearTimeout(request.timeout)
    request.abortCleanup?.()
    this.pending.delete(id)
    return request
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new DesktopTransportError('request-aborted', reason)
  return new DesktopTransportError('request-aborted', 'desktop request was aborted')
}
