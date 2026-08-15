/**
 * @deepseek-ai/dsh-desktop-app — desktop-surface bundle. The package's
 * substance is `cordis.patch.yml`; this module re-exports the runtime and IPC
 * faces so both subpath consumers have one root type anchor.
 * @module @deepseek-ai/dsh-desktop-app
 */

export { DesktopRuntimeService, type DesktopRuntimeHandle } from './runtime.ts'
export { name as ipcPluginName } from './ipc.ts'
export { name as runtimePluginName } from './runtime.ts'
