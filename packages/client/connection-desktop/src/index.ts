
/**
 * Node half of the desktop client connection: a transport-independent host
 * RPC registry. Unlike the Web connection node half it registers no HTTP
 * routes; the desktop-app bundle's IPC row composes it with
 * `toFetchHandler(ctx.apiProxy)` as the `/api` fallback.
 * @module @deepseek-ai/dsh-client-connection-desktop
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type ServerResponse as RpcServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'

/** Stable Cordis plugin name. */
export const name = 'client-connection-desktop'

/** Trust policy kept for Web-carrier API symmetry; desktop IPC is local-only. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
  readonly authority: ConnectionRpcAuthority
}

/** Handler invoked after the desktop carrier has decoded the transport envelope. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Synchronous ownership test for one endpoint on the shared `/api` channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** Host registry for logical RPC channels carried by the desktop IPC transport. */
export interface HostConnectionRpc {
  /** Register one logical channel prefix and its handler. */
  handle(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions): () => Promise<void>
  /** Intercept owned endpoints on the shared `/api` channel before the API gateway fallback. */
  intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by the desktop IPC bridge. */
export interface HostConnectionHandle {
  readonly rpc: HostConnectionRpc
  /** Route one fetch-shaped request through registered channels, then fallback. */
  fetch(request: Request, fallback: { fetch: typeof fetch }): Promise<Response>
}

type FetchHandler = { fetch(request: Request): Promise<Response> }

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const API_PATH = '/api'

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly handler: FetchHandler
}

/** Host-side registry for IPC-carried logical RPC channels. */
export class DesktopHostConnectionService extends Service implements HostConnectionHandle {
  private readonly channels = new Map<string, FetchHandler>()
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) => this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  fetch(request: Request, fallback: { fetch: typeof fetch }): Promise<Response> {
    const pathname = new URL(request.url).pathname
    const interceptor = this.interceptors.get(API_PATH)
    const interceptorEndpoint = endpointFromPath(API_PATH, pathname)
    if (interceptor !== undefined && interceptorEndpoint !== undefined && interceptor.matches(interceptorEndpoint)) {
      return interceptor.handler.fetch(request)
    }
    for (const [channel, handler] of this.channels) {
      if (endpointFromPath(channel, pathname) !== undefined) return handler.fetch(request)
    }
    return fallback.fetch(request)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    return owner.effect(() => {
      this.assertAvailable(channel, options)
      this.channels.set(channel, rpcFetchHandler(channel, handler))
      return () => {
        this.channels.delete(channel)
      }
    }, `client-connection-desktop: ${channel} rpc channel`)
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== API_PATH) throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    return owner.effect(() => {
      this.assertAvailable(channel, options)
      this.interceptors.set(channel, { matches, handler: rpcFetchHandler(channel, handler) })
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection-desktop: ${channel} rpc interceptor`)
  }

  private assertAvailable(channel: string, options: ConnectionRpcHandlerOptions): void {
    // IPC is a local single-operator channel: loopback and trusted-host
    // authorities are equivalent, so the flag is retained for API symmetry
    // with the Web carrier and ignored by the physical trust fence.
    void options
    if (channel === API_PATH ? this.interceptors.has(channel) : this.channels.has(channel)) {
      throw new Error(`connection: RPC channel ${JSON.stringify(channel)} already registered`)
    }
  }
}

/** Plugin body: provide the transport-independent host Connection service. */
export function apply(ctx: Context): void {
  new DesktopHostConnectionService(ctx)
}

function rpcFetchHandler(channel: string, handler: ConnectionRpcHandler): FetchHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) return new Response('not found', { status: 404 })
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) return invalidEnvelopeResponse(body, envelope.error.issues)
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }
      try {
        return fullResponse(message.rpcId, await handler(endpoint, message.payload, request.signal))
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: RpcErrorDetailsMap['bad-request']['issues']): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  return errorResponse(typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: RpcError): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: RpcServerResponse['result']): Response {
  return Response.json({ type: 'server-response', rpcId, result } satisfies RpcServerResponse)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === API_PATH) {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}
