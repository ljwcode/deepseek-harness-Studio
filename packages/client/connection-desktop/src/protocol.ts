
/**
 * Desktop IPC carrier protocol. This module is the single wire vocabulary
 * shared by Electron main, preload, renderer, and the Harness host process.
 * It deliberately contains no Electron, Node, or Cordis imports so every face
 * can bundle it.
 * @module @deepseek-ai/dsh-client-connection-desktop/protocol
 */

/** Stable desktop transport protocol version carried by every renderer frame. */
export const DESKTOP_PROTOCOL_VERSION = 1 as const

/** Machine-readable desktop physical transport failure category. */
export type DesktopTransportErrorCode =
  | 'host-unavailable'
  | 'host-restarting'
  | 'request-aborted'
  | 'request-timeout'
  | 'transport-closed'
  | 'protocol-error'

/**
 * Desktop physical transport error, distinct from a Harness `RpcResult`
 * business error. The former means the carrier could not complete delivery;
 * the latter means the Host answered and the logical request failed.
 */
export class DesktopTransportError extends Error {
  override readonly cause?: unknown

  constructor(
    readonly code: DesktopTransportErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'DesktopTransportError'
    if (cause !== undefined) this.cause = cause
  }
}

/** One client entry in the desktop boot graph (same wire shape as the Web graph). */
export interface DesktopBootEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

/** The desktop boot graph returned by the bootstrap handshake. */
export interface DesktopBootGraph {
  rev: string
  entries: DesktopBootEntry[]
}

/** Serialized subset of RequestInit that can cross the IPC boundary. */
export interface DesktopFetchInit {
  method: string
  headers: Record<string, string>
  body?: string
}

/** Request kinds a renderer may send through the restricted desktop bridge. */
export type DesktopHostRequest =
  | { kind: 'bootstrap' }
  | { kind: 'ping' }
  | { kind: 'bundle'; url: string }
  | { kind: 'fetch'; fetchId: string; url: string; init: DesktopFetchInit }
  | { kind: 'fetch-abort'; fetchId: string }

/** Parent-to-child control request; `shutdown` is never accepted from a renderer. */
export type DesktopChildRequest =
  | DesktopHostRequest
  | { kind: 'shutdown' }

/** Fetch readiness payload returned once the host has response headers. */
export interface DesktopFetchReady {
  status: number
  statusText: string
  headers: Record<string, string>
  /** False for statuses that must not carry a body (204/304/HEAD). */
  hasBody: boolean
}

/** Bundle payload returned for one `/plugins/<id>/client.js` request. */
export interface DesktopBundlePayload {
  contentType: string
  code: string
}

/** Bootstrap value handed back to the renderer, augmented by Electron main. */
export interface DesktopBootstrap {
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  hostGeneration: number
  graph: DesktopBootGraph
  host: unknown
  pid: number
  harnessVersion: string
}

/**
 * Renderer -> Electron-main desktop envelope. `message` is a desktop carrier
 * request; the DSH RPC wire message stays nested inside `fetch.init.body`,
 * never flattened into the Harness wire contract.
 */
export interface DesktopRequestFrame {
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  rendererId: string
  hostGeneration: number
  message: DesktopHostRequest
}

/** Host->renderer streaming events for one open fetch. Chunk data is base64
 *  encoded so every structured-clone transport (Node IPC and Electron IPC)
 *  carries identical bytes without typed-array shape ambiguity. */
export type DesktopIpcEvent =
  | { kind: 'fetch-data'; fetchId: string; data: string }
  | { kind: 'fetch-end'; fetchId: string }
  | { kind: 'fetch-error'; fetchId: string; error: DesktopIpcError }

/** Serializable error shape used across process and renderer boundaries. */
export interface DesktopIpcError {
  code: string
  message: string
}

/** Main/child request correlation envelope. */
export interface DesktopIpcRequestEnvelope {
  kind: 'request'
  requestId: string
  message: DesktopChildRequest
}

/** Main/child response correlation envelope. */
export interface DesktopIpcResponseEnvelope {
  kind: 'response'
  requestId: string
  ok: boolean
  value?: unknown
  error?: DesktopIpcError
}

/** Main/child streaming event envelope. */
export interface DesktopIpcEventEnvelope {
  kind: 'event'
  requestId: string
  event: DesktopIpcEvent
}

/** Host readiness envelope sent after the desktop profile tree settles. */
export interface DesktopIpcReadyEnvelope {
  kind: 'ready'
  pid: number
  profile: 'desktop'
  /** Main-assigned host generation, echoed for stale-ready fencing. */
  generation: number
}

/** Messages the Harness child process emits on its IPC channel. */
export type DesktopChildEnvelope =
  | DesktopIpcReadyEnvelope
  | DesktopIpcResponseEnvelope
  | DesktopIpcEventEnvelope

const REQUEST_KINDS = new Set(['bootstrap', 'ping', 'bundle', 'fetch', 'fetch-abort'])
const URL_PREFIXES = ['/api/', '/plugins/'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function parseFetchInit(value: unknown): DesktopFetchInit | string {
  if (!isRecord(value)) return 'init must be an object'
  const method = stringField(value, 'method')
  if (method === undefined || method === '') return 'init.method must be a non-empty string'
  if (value.headers !== undefined) {
    if (!isRecord(value.headers) || Object.values(value.headers).some(header => typeof header !== 'string')) {
      return 'init.headers must be a string map'
    }
  }
  const body = value.body
  if (body !== undefined && typeof body !== 'string') return 'init.body must be a string'
  return {
    method,
    headers: (value.headers ?? {}) as Record<string, string>,
    ...typeof body === 'string' ? { body } : {},
  }
}

function assertFetchTarget(url: string): string | undefined {
  let pathname: string
  try {
    pathname = new URL(url, 'http://dsh.internal').pathname
  } catch {
    return 'url is not parseable'
  }
  if (!URL_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
    return `url path ${JSON.stringify(pathname)} is outside the allowed /api and /plugins channels`
  }
  return undefined
}

/**
 * Validate an untrusted renderer message.
 * @param value - raw message received through the preload bridge.
 * @returns the typed request, or a diagnostic for an unknown/malformed message.
 */
export function parseDesktopHostRequest(value: unknown): { ok: true; value: DesktopHostRequest } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'desktop request must be an object with a string kind' }
  const kind = stringField(value, 'kind')
  if (kind === undefined || !REQUEST_KINDS.has(kind)) return { ok: false, error: `unknown desktop request kind ${JSON.stringify(kind)}` }
  switch (kind) {
    case 'bootstrap':
    case 'ping':
      return { ok: true, value: { kind } }
    case 'bundle': {
      const url = stringField(value, 'url')
      if (url === undefined) return { ok: false, error: 'bundle request requires a url string' }
      if (!url.startsWith('/plugins/')) return { ok: false, error: 'bundle request url must start with /plugins/' }
      return { ok: true, value: { kind: 'bundle', url } }
    }
    case 'fetch-abort': {
      const fetchId = stringField(value, 'fetchId')
      if (fetchId === undefined || fetchId === '') return { ok: false, error: 'fetch-abort requires a non-empty fetchId' }
      return { ok: true, value: { kind: 'fetch-abort', fetchId } }
    }
    case 'fetch': {
      const fetchId = stringField(value, 'fetchId')
      if (fetchId === undefined || fetchId === '') return { ok: false, error: 'fetch requires a non-empty fetchId' }
      const url = stringField(value, 'url')
      if (url === undefined) return { ok: false, error: 'fetch requires a url string' }
      const targetError = assertFetchTarget(url)
      if (targetError !== undefined) return { ok: false, error: targetError }
      const init = parseFetchInit(value.init)
      if (typeof init === 'string') return { ok: false, error: `fetch: ${init}` }
      return { ok: true, value: { kind: 'fetch', fetchId, url, init } }
    }
    default:
      return { ok: false, error: `unknown desktop request kind ${JSON.stringify(kind)}` }
  }
}

/**
 * Validate a parent-to-child request. The renderer vocabulary is delegated to
 * {@link parseDesktopHostRequest}; the parent-only `shutdown` control request
 * is accepted here and never by the renderer-facing parser.
 */
export function parseDesktopChildRequest(value: unknown): { ok: true; value: DesktopChildRequest } | { ok: false; error: string } {
  if (isRecord(value) && value.kind === 'shutdown') return { ok: true, value: { kind: 'shutdown' } }
  return parseDesktopHostRequest(value)
}

/**
 * Validate the renderer -> main desktop envelope.
 * @param value - raw `dsh:request` frame received from preload.
 * @returns the typed frame, or a diagnostic for an unknown/malformed frame.
 */
export function parseDesktopRequestFrame(value: unknown): { ok: true; value: DesktopRequestFrame } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'desktop request frame must be an object' }
  if (value.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
    return { ok: false, error: `desktop protocolVersion must be ${DESKTOP_PROTOCOL_VERSION}` }
  }
  const rendererId = stringField(value, 'rendererId')
  if (rendererId === undefined || rendererId.length === 0 || rendererId.length > 256) {
    return { ok: false, error: 'desktop request frame requires a non-empty rendererId' }
  }
  const hostGeneration = value.hostGeneration
  if (typeof hostGeneration !== 'number' || !Number.isSafeInteger(hostGeneration) || hostGeneration < 0) {
    return { ok: false, error: 'desktop request frame requires a non-negative integer hostGeneration' }
  }
  const message = parseDesktopHostRequest(value.message)
  if (!message.ok) return { ok: false, error: `desktop request frame: ${message.error}` }
  return { ok: true, value: { protocolVersion: DESKTOP_PROTOCOL_VERSION, rendererId, hostGeneration, message: message.value } }
}

/**
 * Validate a host-child envelope in Electron main.
 * @param value - raw child-process IPC message.
 * @returns the typed envelope, or a diagnostic for an unknown/malformed message.
 */
export function parseDesktopChildEnvelope(value: unknown): { ok: true; value: DesktopChildEnvelope } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'child envelope must be an object with a string kind' }
  const kind = stringField(value, 'kind')
  if (kind === undefined) return { ok: false, error: 'child envelope must be an object with a string kind' }
  if (kind === 'ready') {
    const pid = value.pid
    const profile = stringField(value, 'profile')
    const generation = value.generation
    if (typeof pid === 'number' && profile === 'desktop' && typeof generation === 'number' && Number.isSafeInteger(generation)) {
      return { ok: true, value: { kind: 'ready', pid, profile: 'desktop', generation } }
    }
    return { ok: false, error: 'ready envelope requires numeric pid, desktop profile, and host generation' }
  }
  const requestId = stringField(value, 'requestId')
  if (requestId === undefined) return { ok: false, error: 'child envelope requires requestId' }
  if (kind === 'response') {
    const ok = value.ok === true
    if (!ok && !isRecord(value.error)) return { ok: false, error: 'failed response requires an error object' }
    return {
      ok: true,
      value: {
        kind: 'response',
        requestId,
        ok,
        ...value.value === undefined ? {} : { value: value.value },
        ...(!ok && isRecord(value.error) ? { error: value.error as unknown as DesktopIpcError } : {}),
      },
    }
  }
  if (kind === 'event') {
    if (!isRecord(value.event)) return { ok: false, error: 'event envelope requires a fetch event' }
    const eventKind = stringField(value.event, 'kind')
    const fetchId = stringField(value.event, 'fetchId')
    if (eventKind === undefined || fetchId === undefined) return { ok: false, error: 'event envelope requires a fetch event' }
    if (eventKind === 'fetch-data') {
      const data = stringField(value.event, 'data')
      if (data === undefined) return { ok: false, error: 'fetch-data event requires a base64 data string' }
      return { ok: true, value: { kind: 'event', requestId, event: { kind: 'fetch-data', fetchId, data } } }
    }
    if (eventKind === 'fetch-end') {
      return { ok: true, value: { kind: 'event', requestId, event: { kind: 'fetch-end', fetchId } } }
    }
    if (eventKind === 'fetch-error') {
      const error = value.event.error
      return {
        ok: true,
        value: {
          kind: 'event',
          requestId,
          event: {
            kind: 'fetch-error',
            fetchId,
            error: isRecord(error) ? error as unknown as DesktopIpcError : { code: 'internal', message: String(error) },
          },
        },
      }
    }
    return { ok: false, error: `unknown event kind ${JSON.stringify(eventKind)}` }
  }
  return { ok: false, error: `unknown child envelope kind ${JSON.stringify(kind)}` }
}

/**
 * Build an IPC error with a stable code.
 * @param code - machine-readable error category.
 * @param error - source rejection to stringify.
 * @returns the serializable error envelope field.
 */
export function ipcError(code: string, error: unknown): DesktopIpcError {
  return { code, message: error instanceof Error ? error.message : String(error) }
}
