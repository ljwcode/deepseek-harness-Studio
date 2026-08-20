/* oxlint-disable typescript/no-unsafe-assignment -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-argument -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-return -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-redundant-type-constituents -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-non-null-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-condition -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */

import { EventEmitter } from 'node:events'
import type { ChildProcess, ForkOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { DesktopTransportError } from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import { HarnessProcessManager, type HarnessSpawn } from '../src/main/harness-process.ts'

interface SentEnvelope {
  kind: 'request'
  requestId: string
  message: { kind: string }
}

class FakeHarnessChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly killed: string[] = []
  readonly sent: SentEnvelope[] = []
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid: number

  constructor(pid: number, private readonly options: { autoRespond?: boolean; autoFail?: boolean } = {}) {
    super()
    this.pid = pid
    if (options.autoFail === true) {
      setImmediate(() => { this.fail() })
    }
  }

  send(envelope: unknown, callback?: (error: Error | null) => void): void {
    const sent = envelope as SentEnvelope
    this.sent.push(sent)
    callback?.(null)
    if (sent.message.kind === 'shutdown') {
      setImmediate(() => {
        this.respond(sent.requestId, { shuttingDown: true })
        this.exit(0, null)
      })
      return
    }
    if (this.options.autoRespond !== false) {
      setImmediate(() => {
        if (sent.message.kind === 'ping') this.respond(sent.requestId, { pong: true })
        else if (sent.message.kind === 'bootstrap') this.respond(sent.requestId, { pid: this.pid })
        else this.respond(sent.requestId, { ok: true })
      })
    }
  }

  ready(generation: number): void {
    this.emit('message', { kind: 'ready', pid: this.pid, profile: 'desktop', generation })
  }

  respond(requestId: string, value: unknown): void {
    this.emit('message', { kind: 'response', requestId, ok: true, value })
  }

  fail(): void {
    this.emit('error', new Error(`fake harness ${this.pid} failed to spawn`))
  }

  exit(code: number, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.connected = false
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal)
    return true
  }
}

function asChildProcess(child: FakeHarnessChild): ChildProcess {
  return child as unknown as ChildProcess
}

describe('HarnessProcessManager lifecycle invariants', () => {
  it('fences a delayed old-child exit from the next host generation', async () => {
    const first = new FakeHarnessChild(10)
    const second = new FakeHarnessChild(11)
    const children = [first, second]
    const spawn = vi.fn<HarnessSpawn>((_entry, _args, _options: ForkOptions) => {
      const child = children.shift()
      if (child === undefined) throw new Error('unexpected extra spawn')
      return asChildProcess(child)
    })
    const manager = new HarnessProcessManager({
      entry: 'dsh-fake',
      restart: true,
      restartBaseMs: 0,
      restartDelaysMs: [1, 1],
      crashLimit: 5,
      spawn,
    })
    manager.start()
    first.ready(1)
    await manager.waitUntilReady(1_000)
    expect(manager.hostGeneration).toBe(1)

    first.fail()
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2) }, { timeout: 1_000 })
    expect(manager.hostGeneration).toBe(2)
    second.ready(2)
    await manager.waitUntilReady(1_000)

    first.exit(1, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(manager.state).toBe('ready')
    expect(manager.pid).toBe(second.pid)

    await manager.stop(200)
    expect(manager.state).toBe('stopped')
  })

  it('rejects every pending request of the crashed host generation', async () => {
    const child = new FakeHarnessChild(20, { autoRespond: false })
    const spawn = vi.fn<HarnessSpawn>(() => asChildProcess(child))
    const manager = new HarnessProcessManager({ entry: 'dsh-fake', restart: false, spawn })
    manager.start()
    child.ready(manager.hostGeneration)
    await manager.waitUntilReady(1_000)

    const pending = manager.request({ kind: 'ping' }, { rendererId: 'renderer-a' })
    child.exit(1, 'SIGKILL')
    const error = await pending.then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(DesktopTransportError)
    expect((error as DesktopTransportError).code).toBe('host-unavailable')
    expect(manager.state).toBe('failed')
    await manager.stop()
  })

  it('does not restart after an intentional shutdown', async () => {
    const child = new FakeHarnessChild(30)
    const spawn = vi.fn<HarnessSpawn>(() => asChildProcess(child))
    const manager = new HarnessProcessManager({
      entry: 'dsh-fake',
      restart: true,
      restartBaseMs: 0,
      restartDelaysMs: [1, 1],
      crashLimit: 5,
      spawn,
    })
    manager.start()
    child.ready(manager.hostGeneration)
    await manager.waitUntilReady(1_000)
    expect(manager.desired).toBe('running')

    await manager.stop(200)
    expect(manager.state).toBe('stopped')
    expect(manager.desired).toBe('stopped')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('enters failed after the crash-loop threshold and stops auto-restarting', async () => {
    let crashChildIndex = 0
    const spawn = vi.fn<HarnessSpawn>((_entry, _args, _options: ForkOptions) => {
      crashChildIndex += 1
      return asChildProcess(new FakeHarnessChild(40 + crashChildIndex, { autoFail: true }))
    })
    const manager = new HarnessProcessManager({
      entry: 'dsh-fake',
      restart: true,
      restartBaseMs: 0,
      restartDelaysMs: [1, 1],
      crashWindowMs: 60_000,
      crashLimit: 3,
      spawn,
    })
    const crashLoop = vi.fn()
    manager.on('crash-loop', crashLoop)
    manager.start()
    await vi.waitFor(() => { expect(manager.state).toBe('failed') }, { timeout: 1_000 })
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(crashLoop).toHaveBeenCalledTimes(1)
    await manager.stop()
  })

  it('scopes renderer aborts without disturbing other renderer requests', async () => {
    const child = new FakeHarnessChild(50, { autoRespond: false })
    const manager = new HarnessProcessManager({
      entry: 'dsh-fake',
      restart: false,
      spawn: () => asChildProcess(child),
    })
    manager.start()
    child.ready(manager.hostGeneration)
    await manager.waitUntilReady(1_000)

    const pendingA = manager.request({ kind: 'ping' }, { rendererId: 'renderer-a' })
    const pendingB = manager.request({ kind: 'ping' }, { rendererId: 'renderer-b' })
    manager.abortRenderer('renderer-a')
    await expect(pendingA).rejects.toMatchObject({ code: 'request-aborted' })

    const envelopeB = child.sent.find(envelope => envelope.message.kind === 'ping' && envelope.requestId !== child.sent[0]?.requestId)
    expect(envelopeB).toBeDefined()
    child.respond(envelopeB!.requestId, { pong: true })
    await expect(pendingB).resolves.toEqual({ pong: true })
    await manager.stop()
  })
})
