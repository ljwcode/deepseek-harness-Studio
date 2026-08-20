
/**
 * DSH Studio renderer entry. It receives the host-composed boot graph over
 * the preload bridge, installs it as `window.__DSH_BOOT__`, and reuses the
 * existing dsh-client-web shell kernel with an IPC bundle loader.
 */

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { apply as modulesApply, createClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget,
  ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import type { DesktopBootGraph } from '@deepseek-ai/dsh-client-connection-desktop/protocol'

/** Bootstrap package whose client bundle supplies the module-system implementation. */
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

/**
 * Install the `window.__ModuleLoader__` registration facade. The desktop
 * renderer compiles the modules client face directly (no parser-preloaded
 * classic scripts), so `create` materializes the bootstrap module from the
 * direct import instead of draining a preloaded bundle registration.
 * @returns the installed facade; an existing one is reused.
 */
function installModuleLoader(): ClientModuleLoaderTarget {
  const win = globalThis as DshWindow
  const existing = win.__ModuleLoader__
  if (existing !== undefined) return existing
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load(registration) { pendingQueue.push(registration) },
    create(options: ClientModuleCreateOptions): ClientModuleSystem {
      if (target.mode !== 'queue') {
        throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot')
      }
      return createClientModuleSystem(target, {
        id: CLIENT_MODULES_ID,
        exports: { createClientModuleSystem, apply: modulesApply },
      }, options)
    },
  }
  win.__ModuleLoader__ = target
  return target
}

interface BootstrapPayload {
  graph: DesktopBootGraph
  host: unknown
  pid: number
}

interface BundlePayload {
  contentType: string
  code: string
}

function isBootstrapPayload(value: unknown): value is BootstrapPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  if (typeof payload.pid !== 'number') return false
  const graph = payload.graph as Record<string, unknown> | null | undefined
  return typeof graph === 'object' && graph !== null
    && typeof graph.rev === 'string' && Array.isArray(graph.entries)
}

function isBundlePayload(value: unknown): value is BundlePayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return typeof payload.contentType === 'string' && typeof payload.code === 'string'
}

async function bootstrap(): Promise<BootstrapPayload> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const value = await window.dshDesktop.bootstrap()
      if (isBootstrapPayload(value)) return value
      throw new Error('desktop bootstrap returned an invalid payload')
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

function executeClassicScript(code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([code], { type: 'text/javascript; charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const script = document.createElement('script')
    script.async = true
    script.src = url
    script.addEventListener('load', () => {
      script.remove()
      URL.revokeObjectURL(url)
      resolve()
    }, { once: true })
    script.addEventListener('error', () => {
      script.remove()
      URL.revokeObjectURL(url)
      reject(new Error(`desktop bundle script failed for ${script.src}`))
    }, { once: true })
    document.head.append(script)
  })
}

async function loadDesktopBundle(url: string): Promise<void> {
  const value = await window.dshDesktop.request({ kind: 'bundle', url })
  if (!isBundlePayload(value)) throw new Error(`desktop bundle response for ${url} was invalid`)
  await executeClassicScript(value.code)
}

function renderBootError(error: unknown): void {
  const el = document.getElementById('root')
  if (el === null) return
  const message = error instanceof Error ? error.message : String(error)
  el.innerHTML = `<pre style="white-space:pre-wrap;padding:24px;font:14px ui-monospace,monospace">DSH Studio failed to start:\n${message}</pre>`
}

async function main(): Promise<void> {
  const el = document.getElementById('root')
  if (el === null) throw new Error('desktop app: missing #root')
  try {
    const payload = await bootstrap()
    ;(window as typeof window & { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = payload.graph
    installModuleLoader()
    const entry = new AppWebEntry(el, { loadBundle: loadDesktopBundle })
    await entry.run()
    console.log('[renderer] DSH Studio boot settled')
  } catch (error) {
    console.error(error)
    renderBootError(error)
  }
}

void main()
