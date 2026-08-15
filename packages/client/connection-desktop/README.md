# `@deepseek-ai/dsh-client-connection-desktop`

English | [中文](README.zh.md)

Desktop IPC carrier for the dsh client. The node half provides a transport-independent Host RPC registry (`ctx.connection`) whose `/api` interceptor composes Typert Remote endpoints ahead of the shared API gateway; the client half provides `DesktopApiClient` (an `AbstractApiClient` subclass whose `doFetch` crosses the restricted preload bridge), the generic logical-RPC caller, and the dual-stream reconnect controller shared by the existing Session runtime. No HTTP or WebSocket server is involved.

The physical channel is `window.dshDesktop`, installed by the Electron preload with `contextIsolation = true` and `nodeIntegration = false`. Main validates every renderer message before forwarding it to the Harness child process; fetch bodies and streaming chunks cross process boundaries with the same `ClientRequest`/`ServerResponse`/`ServerRequest` envelope contract as the Web carrier.

## Model Experience

None, as the desktop wire layer moves already-composed messages between renderer and host; it registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One renderer, one Harness child** — the Electron main broker currently targets the single main window; multi-window fan-out is deferred.
- **Desktop IPC trust is local-process trust** — the preload bridge is the authentication boundary; renderer compromise can request any allowed `/api` method, exactly like the loopback Web client.
