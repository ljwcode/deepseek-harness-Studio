
/**
 * Desktop client-graph composer. The Web surface owns the same job in
 * `dsh-client-modules` (serving bundles and injecting `window.__DSH_BOOT__`
 * through a webserver); the desktop surface needs no HTTP route, so this
 * runtime scans the mounted `dsh.client` rows and exposes the resulting graph
 * plus bundle reads to the IPC bridge.
 * @module @deepseek-ai/dsh-desktop-app/runtime
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { DesktopBootEntry, DesktopBootGraph } from '@deepseek-ai/dsh-client-connection-desktop/protocol'

/** Stable Cordis plugin name. */
export const name = 'desktop-runtime'

/** Package.json `dsh.client` fields consumed by the desktop composer. */
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  immediately?: boolean
}

interface ClientRecord {
  entry: DesktopBootEntry
  clientPath: string
}

/** Client packages the desktop surface accepts. Web is allowed because the
 *  existing UI plugin tree declares platform web and desktop is a carrier
 *  change, not a plugin-platform change. The desktop connection package
 *  declares desktop. */
const ACCEPTED_PLATFORMS = new Set(['web', 'desktop'])

const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

/** Services required before the graph can be resolved. */
export const inject = ['loader']

/** Host service exposed to the desktop IPC row. */
export interface DesktopRuntimeHandle {
  /**
   * Compose the current client boot graph from active `dsh.client` loader entries.
   * @returns the graph whose `rev` covers every row and bundle hash.
   */
  graph(): DesktopBootGraph
  /**
   * Read one built client bundle (or its source map) by boot-graph URL.
   * @param url - a `/plugins/<id>/client.js[.map]` boot-graph URL.
   * @returns the bundle content type and UTF-8 source text.
   */
  readBundle(url: string): { contentType: string; code: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopRuntime: DesktopRuntimeHandle
  }
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`desktop-runtime: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`desktop-runtime: ${pkgName} dsh.client.platform must be a string`)
  }
  if (decl.inject !== undefined && (!Array.isArray(decl.inject) || decl.inject.some(i => typeof i !== 'string'))) {
    throw new Error(`desktop-runtime: ${pkgName} dsh.client.inject must be a string array`)
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`desktop-runtime: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...decl.inject === undefined ? {} : { inject: decl.inject as string[] },
    ...decl.immediately === undefined ? {} : { immediately: decl.immediately },
  }
}

function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`desktop-runtime: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

function graphRow(id: string, rev: string, inject: string[] | undefined, immediately: boolean): DesktopBootEntry {
  return {
    id,
    url: `/plugins/${encodeURIComponent(id)}/client.js?rev=${rev}`,
    rev,
    ...inject === undefined ? {} : { inject },
    ...immediately ? { immediately: true } : {},
  }
}

/** Desktop client graph service: scan-on-read, no cached bundle metadata. */
export class DesktopRuntimeService extends Service implements DesktopRuntimeHandle {
  private readonly resolvePkgJson: (spec: string) => string

  constructor(ctx: Context) {
    super(ctx, 'desktopRuntime')
    if (ctx.baseUrl === undefined) {
      throw new Error('desktop-runtime: ctx.baseUrl is unset — the node half needs the config-tree anchor to resolve plugin packages')
    }
    const require = createRequire(ctx.baseUrl)
    this.resolvePkgJson = spec => require.resolve(`${spec}/package.json`)
  }

  graph(): DesktopBootGraph {
    const entries = this.scan().map(record => record.entry)
    return { rev: shortHash(JSON.stringify(entries)), entries }
  }

  readBundle(url: string): { contentType: string; code: string } {
    const parsed = new URL(url, 'http://dsh.internal')
    const prefix = '/plugins/'
    const bundleSuffix = '/client.js'
    const mapSuffix = '/client.js.map'
    const pathname = decodeURIComponent(parsed.pathname)
    if (!pathname.startsWith(prefix) || (!pathname.endsWith(bundleSuffix) && !pathname.endsWith(mapSuffix))) {
      throw new Error(`desktop-runtime: invalid bundle path ${JSON.stringify(url)}`)
    }
    const isSourceMap = pathname.endsWith(mapSuffix)
    const suffix = isSourceMap ? mapSuffix : bundleSuffix
    const id = pathname.slice(prefix.length, -suffix.length)
    const record = this.scan().find(candidate => candidate.entry.id === id)
    if (record === undefined) throw new Error(`desktop-runtime: unknown client bundle ${JSON.stringify(id)}`)
    const path = `${record.clientPath}${isSourceMap ? '.map' : ''}`
    let body: string
    try {
      body = readFileSync(path, 'utf8')
    } catch (error) {
      throw new Error(`desktop-runtime: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}: ${path}`, { cause: error })
    }
    return {
      contentType: isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
      code: body,
    }
  }

  private scan(): ClientRecord[] {
    const records: ClientRecord[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.disabled || entry.fiber === undefined) continue
      const pkgName = entry.options.name
      let pkgPath: string
      try {
        pkgPath = this.resolvePkgJson(pkgName)
      } catch {
        continue // loader builtins and subpath entries are not client rows
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
      const dsh = pkg.dsh
      const decl = parseDshClient(pkgName, dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined)
      if (decl === undefined || !ACCEPTED_PLATFORMS.has(decl.platform)) continue
      const clientRel = clientExportOf(pkgName, pkg.exports)
      if (clientRel === undefined) {
        throw new Error(`desktop-runtime: ${pkgName} declares dsh.client but exports no "./client" bundle`)
      }
      const clientPath = join(dirname(pkgPath), clientRel)
      let body: string
      try {
        body = readFileSync(clientPath, 'utf8')
      } catch (error) {
        throw new Error(`desktop-runtime: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}: ${clientPath}`, { cause: error })
      }
      records.push({
        entry: graphRow(pkgName, shortHash(body), decl.inject, decl.immediately === true),
        clientPath,
      })
    }
    return records
  }
}

/** Plugin body: provide the desktop client graph service. */
export function apply(ctx: Context): void {
  new DesktopRuntimeService(ctx)
}
