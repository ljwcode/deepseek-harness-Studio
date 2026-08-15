# `@deepseek-ai/dsh-client-connection-desktop`

[English](README.md) | 中文

dsh 客户端的桌面 IPC 载体。node 侧提供与传输无关的 Host RPC 注册表（`ctx.connection`），其 `/api` 拦截器把 Typert Remote 端点组合在共享 API 网关之前；client 侧提供 `DesktopApiClient`（`AbstractApiClient` 子类，`doFetch` 穿过受限 preload 桥）、通用逻辑 RPC 调用器，以及现有 Session 运行时共享的双流重连控制器。整个过程不涉及 HTTP 或 WebSocket 服务器。

物理通道是 `window.dshDesktop`，由 Electron preload 在 `contextIsolation = true`、`nodeIntegration = false` 下安装。主进程先校验每条渲染进程消息，再转发给 Harness 子进程；fetch 请求体和流式分片跨进程传递时，保持与 Web 载体相同的 `ClientRequest`/`ServerResponse`/`ServerRequest` 信封契约。

## Model Experience

无。桌面线路层只是在渲染进程与 Host 之间搬运已组装消息，不注册任何面向模型的内容。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **单个渲染窗口对应单个 Harness 子进程**——Electron 主进程代理当前只面向主窗口，多窗口扇出尚未实现。
- **桌面 IPC 信任即本机进程信任**——preload 桥是认证边界；渲染进程失陷后可请求任意允许的 `/api` 方法，与 loopback Web 客户端一致。
