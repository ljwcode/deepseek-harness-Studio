# Agent Note：桌面运行时 Phase 1B 验收

状态：已实现

[English](2026-08-15-desktop-phase1b-runtime-acceptance.md) | 中文

## 问题

Phase 1A 证明 Electron 壳与桌面 IPC 载波可以启动，但 Harness 进程管理器仍存在未防护的子进程生命周期竞态：旧进程延迟退出可能误判新 generation 失败；主动关停与崩溃退避没有区分；崩溃后未决 IPC 请求可能永久挂起；渲染进程重载没有稳定身份，也不会清理旧请求。

运行时也缺少确定性的“模型 + 工具”链路。原有桌面集成测试只停留在“收到 IPC frame”，没有证明真实 Agent Loop 能通过桌面载波完成流式输出、工具调用、审批/提问回答、取消停滞请求、保留排队任务，以及子进程崩溃或冷启动后的恢复。

此外，`Agent.cancel({ keepInbox: true })` 会把活动 driver 运行期间到达的排队工作暂时停放。于是“第一个请求停滞、第二个请求排队、取消第一个”之后，第二个请求还需要额外一次唤醒；桌面队列保留不变量暴露了这个问题。

## 决策

Phase 1B 在不新增产品 UI 的前提下，让桌面载波具备生命周期安全性与可测试性：

- `HarnessProcessManager` 引入单调 host generation 围栏、显式 `desired` running/stopped 状态、500ms→10s 重启阶梯、5 次/60 秒崩溃环熔断、统一的 `IpcRequestRegistry`，以及先 `desktop/shutdown`（释放 Cordis 树、断开 IPC、退出）再 SIGTERM/SIGKILL 的优雅关停协议。
- 渲染进程 frame 携带 `protocolVersion`、preload 启动时生成的 `rendererId` 与主进程持有的 `hostGeneration`；Electron main 拒绝过期 generation，并在 webContents 销毁或重载时中止该 renderer 拥有的请求与流。
- `DesktopApiClient` 将“等待响应头”的 Promise 纳入 stream 状态，使 abort 与 `close()` 能让尚未收到响应头的请求收敛，而不是悬挂。
- `@deepseek-ai/dsh-desktop-runtime-fixture` 提供 `fixture_echo`、`fixture_wait`、`fixture_approval`、`fixture_question` 与 `fixture_fail`，只通过 `apps/desktop/tests/fixtures/desktop-test.patch.yml` 挂载。
- Runtime E2E 使用真实 mock LLM HTTP/SSE 服务、真实 DeepSeek adapter 与真实 Agent Loop，经原始桌面 IPC 验证：prompt 流式输出、多步工具、审批稳定 rpcId 重放、提问校验权威、stall/cancel、队列保留、冷持久化与 SIGKILL 崩溃恢复。
- Core Agent Loop 在 `keepInbox` 取消时，若 inbox 已有未决工作则设置 latch，使 live turn 期间入队的任务在取消收敛后自动续跑；其他 live-driver 语义保持不变。

## 验证

`pnpm run test:desktop` 运行 27 个传输/生命周期测试与 9 个 Runtime E2E 测试；`packages/core/agent-loop/tests` 保持绿色（329 个测试），包括更新后的取消测试套件。`@deepseek-ai/dsh-desktop` typecheck 与聚焦 oxlint 通过。

## 备选方案

**只保留 frame 级测试。** 否决：它无法区分“能工作的 Agent”与“只会转发 JSON 的载波”。

**让排队任务在取消后继续停放，等待额外唤醒。** 否决：桌面 prompt B 必须在取消 A 后自动完成，不应依赖产品层唤醒 hack；core 原语才是正确权威。

**每个运行时场景都跑 Electron/Playwright。** PR 阻塞切片中否决：真实 Harness 进程上的原始桌面 IPC 更快、更确定；Electron GUI E2E 留作后续门禁。

## 后果

桌面生命周期竞态与未决请求泄漏由 main 侧基础设施负责，不再散落在 renderer 代码中。Runtime E2E 可在无真实模型凭据的情况下按域扩展。`cancel({ keepInbox: true })` 现在会续跑取消时已经排队的任务；依赖旧“停放直到再次唤醒”行为的调用方，只需关注收敛后再排队的工作——那部分本来就会正常启动。
