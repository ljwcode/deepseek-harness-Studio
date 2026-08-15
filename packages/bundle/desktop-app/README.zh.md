# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

dsh 桌面表面 bundle。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.md) 上：固定原生目录选择器，挂载 API 网关、插件清单、存储、工作区以及完整的现有客户端 UI 清单，并用 `connection-desktop` 加桌面运行时和 IPC 行替换 Web HTTP/WebSocket 载体。它不挂载 webserver、frontend-static、web-startup 或 Web connection 行。

`runtime` 把组合后的 `dsh.client` 清单扫描为返回给渲染进程的启动图，并通过 IPC 读取构建好的客户端 bundle。`ipc` 在 Electron 主进程未设置 `DSH_DESKTOP_IPC=1` 时保持惰性；启用后，它基于 `ctx.apiProxy` 和与传输无关的 `ctx.connection` 注册表应答 bootstrap、ping、bundle 与 fetch 请求。

## Model Experience

间接生效：本 bundle 只重述了 system-prompt persona；其他所有面向模型的效果都属于补丁所挂载的各行包。

#### KV Cache effect

重述的 persona 只改变固定的部署提示文本；本包不增加任何按请求或按会话变化的 token 内容。

## Known Limitations and Deferred Work

- **每次 bootstrap 都重新读取 bundle 哈希**——运行时有意重新扫描而不缓存；客户端 HMR 已禁用，插件变更需重启 Harness 后生效。
- **桌面数据布局尚未迁移**——Electron 壳把 `DSH_HOME` 指向 Studio home，但导入现有 CLI profile 尚未实现。
