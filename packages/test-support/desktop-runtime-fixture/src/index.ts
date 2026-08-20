/**
 * Deterministic tools for Phase 1B desktop runtime E2E. This plugin is loaded
 * only through the test overlay patch and never appears in the production
 * desktop profile bundle.
 */

import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

interface FixtureQuestionService {
  ask(req: {
    questions: unknown[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

export const name = 'desktop-runtime-fixture'
export const inject = ['tools', 'approval', 'userQuestions', 'jobs']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(defineTool({
        name: 'fixture_echo',
        description: 'Deterministic test tool: return the supplied text unchanged.',
        parameters: {
          text: { type: 'string', required: true, description: 'Text to echo back.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              echo: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `echo: ${String((value as { echo: unknown }).echo)}` }],
        },
        async execute(args) {
          await Promise.resolve()
          return { echo: args.text }
        },
      })),
      ctx.tools.register(defineTool({
        name: 'fixture_wait',
        description: 'Deterministic test tool: wait for the requested number of milliseconds, then return.',
        parameters: {
          ms: { type: 'integer', required: true, description: 'Delay in milliseconds.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              waitedMs: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `waited ${String((value as { waitedMs: unknown }).waitedMs)}ms` }],
        },
        async execute(args, exec) {
          try {
            await delay(args.ms, undefined, { signal: exec.signal })
          } catch (error) {
            if (exec.signal.aborted) throw error
            throw error
          }
          return { waitedMs: args.ms }
        },
      })),
      ctx.tools.register(defineTool({
        name: 'fixture_approval',
        description: 'Deterministic test tool: request one approval decision and return its outcome.',
        parameters: {
          reason: { type: 'string', required: true, description: 'Approval reason.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              outcome: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `approval: ${String((value as { outcome: unknown }).outcome)}` }],
        },
        async execute(args, exec) {
          const approval = (ctx as unknown as { approval?: {
            request(req: { agent: unknown; toolName: string; callId: unknown; reason: string; signal?: AbortSignal }): Promise<string>
          } }).approval
          if (approval === undefined || exec.agent === undefined) {
            throw new Error('fixture_approval requires ctx.approval and an agent execution')
          }
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: 'fixture_approval',
            callId: exec.callId,
            reason: args.reason,
            signal: exec.signal,
          })
          return { outcome }
        },
      })),
      ctx.tools.register(defineTool({
        name: 'fixture_question',
        description: 'Deterministic test tool: ask the user one question and return the answer.',
        parameters: {
          id: { type: 'string', required: true, description: 'Stable question id.' },
          question: { type: 'string', required: true, description: 'Question text.' },
          options: { type: 'array', description: 'Optional option labels.', items: { type: 'string' } },
          multi_select: { type: 'boolean', description: 'Whether multiple options may be selected.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              answers: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    selected: { type: 'array', required: true, items: { type: 'string' } },
                    custom: { type: 'string' },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `answer: ${JSON.stringify((value as { answers: unknown }).answers)}` }],
        },
        async execute(args, exec) {
          const service = (ctx as unknown as { userQuestions?: FixtureQuestionService }).userQuestions
          if (service === undefined || exec.agent === undefined) {
            throw new Error('fixture_question requires ctx.userQuestions and an agent execution')
          }
          const options = (args.options ?? []).map((label: string) => ({ label }))
          const question = {
            id: args.id,
            question: args.question,
            ...options.length > 0 ? { options } : {},
            ...args.multi_select === true ? { multiSelect: true } : {},
          }
          const answer = await service.ask({ questions: [question], agent: exec.agent, signal: exec.signal })
          return { answers: answer.answers }
        },
      })),
      ctx.tools.register(defineTool({
        name: 'fixture_job',
        description: 'Deterministic test tool: register a short-lived background job and return its job id.',
        parameters: {
          label: { type: 'string', required: true, description: 'Job label.' },
          ms: { type: 'integer', required: true, description: 'Job duration in milliseconds.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobId: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `job: ${String((value as { jobId: unknown }).jobId)}` }],
        },
        async execute(args, exec) {
          await Promise.resolve()
          const jobs = (ctx as unknown as {
            jobs?: {
              start(spec: {
                kind: string
                label: string
                owner?: unknown
                run(): unknown
              }): string
            }
          }).jobs
          if (jobs === undefined || exec.agent === undefined) {
            throw new Error('fixture_job requires ctx.jobs and an agent execution')
          }
          const jobId = jobs.start({
            kind: 'fixture',
            label: args.label,
            owner: exec.agent,
            run() {
              let settled = false
              let finish = (_outcome: { status: 'completed' | 'killed' | 'failed'; output?: string }): void => {}
              let output = ''
              const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; output?: string }>((resolve) => {
                finish = resolve
              })
              const timer = setTimeout(() => {
                if (settled) return
                settled = true
                output = `${args.label} completed`
                finish({ status: 'completed', output })
              }, args.ms)
              return {
                cancel() {
                  if (settled) return
                  settled = true
                  clearTimeout(timer)
                  output = `${args.label} cancelled`
                  finish({ status: 'killed', output })
                },
                done,
                readOutput() {
                  const current = output
                  output = ''
                  return current
                },
              }
            },
          })
          return { jobId }
        },
      })),
      ctx.tools.register(defineTool({
        name: 'fixture_fail',
        description: 'Deterministic test tool: always fail.',
        parameters: {
          message: { type: 'string', required: true, description: 'Failure message.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              failed: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `failed: ${String((value as { failed: unknown }).failed)}` }],
        },
        async execute(args) {
          await Promise.resolve()
          throw new Error(args.message)
        },
      })),
    ]
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'desktop-runtime-fixture tools')
}
