/* oxlint-disable typescript/no-unsafe-assignment -- raw child-process IPC fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw child-process IPC fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw child-process IPC fixtures are deliberately narrowed by hand. */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessProcessManager } from '../src/main/harness-process.ts'

const managers: HarnessProcessManager[] = []

async function startManager(restart: boolean): Promise<HarnessProcessManager> {
  const studioHome = mkdtempSync(join(tmpdir(), 'dsh-studio-manager-'))
  const manager = new HarnessProcessManager({
    env: { DSH_STUDIO_HOME: studioHome, DSH_TELEMETRY_DISABLED: '1' },
    restart,
    restartBaseMs: 20,
  })
  managers.push(manager)
  manager.start()
  await manager.waitUntilReady(45_000)
  return manager
}

const CLI_ENTRY = join(process.cwd(), 'apps/cli/lib/bin.js')

describe.skipIf(!existsSync(CLI_ENTRY))('HarnessProcessManager', () => {
  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      await manager.stop(5_000).catch(() => undefined)
    }
  })

  it('starts the desktop profile in an independent process and answers IPC health probes', async () => {
    const manager = await startManager(false)
    expect(manager.state).toBe('ready')
    expect(manager.pid).toBeTypeOf('number')
    await expect(manager.health()).resolves.toBe(true)
    const bootstrap = await manager.request({ kind: 'bootstrap' }) as { pid: number }
    expect(bootstrap.pid).toBe(manager.pid)
  }, 60_000)

  it('restarts the Harness after a crash without stopping the manager', async () => {
    const manager = await startManager(true)
    const firstPid = manager.pid!
    process.kill(firstPid, 'SIGKILL')
    await vi.waitFor(() => {
      expect(manager.state === 'failed' || manager.state === 'restarting' || manager.pid !== firstPid).toBe(true)
    }, { timeout: 15_000 })
    await expect(manager.waitUntilReady(45_000)).resolves.toBeUndefined()
    expect(manager.state).toBe('ready')
    expect(manager.pid).not.toBe(firstPid)
    await expect(manager.health()).resolves.toBe(true)
  }, 70_000)
})
