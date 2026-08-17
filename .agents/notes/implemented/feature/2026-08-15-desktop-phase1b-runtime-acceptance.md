# Agent Note: Desktop Runtime Phase 1B acceptance

Status: implemented

English | [中文](2026-08-15-desktop-phase1b-runtime-acceptance.zh.md)

## Problem

Phase 1A proved the Electron shell and desktop IPC carrier could boot, but the Harness process manager still had unguarded child lifecycle races: stale exits could mark a newer generation failed, intentional shutdown and crash-loop backoff were not distinguished, pending IPC requests could hang after a crash, and renderer reloads had no stable identity or request cleanup.

The runtime also lacked a deterministic model-plus-tool path. Existing desktop integration tests stopped at “IPC frame received”; they did not prove that a real agent loop over the desktop carrier could stream, call tools, answer approvals/questions, cancel a stalled provider, preserve a queued prompt, and recover from child crashes or cold restarts.

Finally, `Agent.cancel({ keepInbox: true })` parked queued work that arrived while a live driver was running. A stalled first prompt and a queued second prompt therefore required a third wake after cancellation; the desktop queue-preservation invariant exposed this.

## Decision

Phase 1B makes the desktop carrier lifecycle-safe and testable without adding product UI:

- `HarnessProcessManager` now uses a monotonic host generation fence, explicit `desired` running/stopped state, a 500ms→10s restart ladder, a 5-crash/60s crash-loop gate, a unified `IpcRequestRegistry`, and a `desktop/shutdown` graceful protocol (dispose Cordis tree, release IPC, exit) before SIGTERM/SIGKILL.
- Renderer frames carry `protocolVersion`, a preload-boot `rendererId`, and the main-owned `hostGeneration`; Electron main rejects stale generations and aborts renderer-owned requests/streams when a webContents is disposed or reloads.
- `DesktopApiClient` registers the bridge-readiness promise in its stream state, so aborts and `close()` settle requests that have not received headers instead of hanging.
- `@deepseek-ai/dsh-desktop-runtime-fixture` adds `fixture_echo`, `fixture_wait`, `fixture_approval`, `fixture_question`, `fixture_job`, and `fixture_fail`, mounted only through `apps/desktop/tests/fixtures/desktop-test.patch.yml`.
- Runtime E2E uses the real mock LLM HTTP/SSE server, the real DeepSeek adapter, and the real agent loop over raw desktop IPC: prompt streaming, multi-step tool, approval replay with stable rpcId, question validation authority, stall/cancel, queue preservation, cold persistence, SIGKILL crash recovery, goal write/projection/clear, job snapshot streaming, and subagent catalog baseline.
- Electron smoke launches the built app through Playwright `_electron`, reloads the renderer with a new rendererId while keeping the Harness generation and pid stable, streams a real prompt, and verifies session resync after a Harness child SIGKILL.
- Core agent loop now latches `keepInbox` cancellation when pending work exists at cancel time, so queued work that arrived during a live turn resumes automatically after the cancelled turn converges. Other live-driver semantics are unchanged.

## Verification

`pnpm run test:desktop` runs 27 transport/lifecycle tests and 12 runtime E2E tests; `pnpm run test:desktop:electron` adds 2 Electron smoke tests (boot/reload and prompt/reload/SIGKILL recovery). `packages/core/agent-loop/tests` stays green (329 tests), including the updated cancellation suite. `@deepseek-ai/dsh-desktop` typecheck, desktop build, and focused oxlint pass.

## Alternatives considered

**Keep runtime tests at the frame level.** Rejected because it cannot distinguish a functioning agent from a carrier that only forwards JSON.

**Leave queued-after-cancel work parked until another wake.** Rejected because desktop prompt B must complete after cancel A without a product-layer wake hack; the core primitive is the correct authority.

**Drive E2E with Electron/Playwright for every runtime case.** Rejected: the deterministic matrix stays on raw desktop IPC; Electron is reserved for shell-specific invariants (boot, renderer reload, real Harness child SIGKILL recovery) and now runs as a small PR-blocking smoke suite.

## Consequences

Desktop lifecycle races and pending-request leaks are now owned by main-side infrastructure, not renderer code. Runtime E2E can be extended per domain without real provider credentials. `cancel({ keepInbox: true })` now resumes queued work that was pending at cancellation; callers that relied on the previous park-until-another-wake behavior must send an explicit wake only for work queued after convergence, which already starts normally.
