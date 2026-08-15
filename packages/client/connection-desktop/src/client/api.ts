/** Browser-safe contract re-export point for the desktop connection client. */

export type {
  ApiProxy, ClientRequest, ClientResponse, RpcRequest, RpcResponse, RpcResult,
  RpcError, RpcErrorCode, RpcMessage, RpcReceipt, ServerRequest, ServerResponse,
  HostFrame, MuxFrame, ModelSelection, QueueAction,
} from '@deepseek-ai/dsh-host-apiproxy/api'
export { RpcId, transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
export { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
export type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'

/** Successful value returned by the connection-generation host handshake. */
export type HostDescription = import('@deepseek-ai/dsh-host-apiproxy/api').ResponseValue<'host.describe'>
