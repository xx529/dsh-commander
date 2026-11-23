import test from 'node:test'
import assert from 'node:assert/strict'
import { attachSessionQuestions, readSessionUserQuestions } from '../../src/host/dispatch/session-questions.ts'
import type { DispatchSessionInput } from '../../src/host/jev/request.ts'

const events = [
  { type: 'user/message', data: { content: [{ type: 'text', text: '把订单导出改成流式' }], source: { kind: 'user' } } },
  { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. cwd=…' }], source: { kind: 'runtime-context' } } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder> workspace instructions' }] } },
  { type: 'assistant/message', data: { content: [{ type: 'text', text: '好的' }] } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '顺手补个单测' }], source: { kind: 'user' } } },
]

function fakeCtx(bySession: Record<string, Array<Record<string, unknown>>>) {
  return {
    get: (name: string) => {
      if (name === 'sessionQuery') {
        return {
          readSession: async (sessionId: string) => ({ events: bySession[sessionId] ?? [] }),
        }
      }
      return undefined
    },
  } as never
}

test('readSessionUserQuestions keeps real user prompts and drops injected notices', async () => {
  const ctx = fakeCtx({ 's-1': events })
  assert.deepEqual(await readSessionUserQuestions(ctx, 's-1'), ['把订单导出改成流式', '顺手补个单测'])
})

test('readSessionUserQuestions returns [] for unreadable sessions', async () => {
  const ctx = fakeCtx({})
  assert.deepEqual(await readSessionUserQuestions(ctx, 'missing'), [])
})

test('readSessionUserQuestions over 20 keeps first, last and the 18 longest middle questions', async () => {
  const text = (index: number, length: number): string => {
    const prefix = `q${index}-`
    return prefix + 'x'.repeat(length - prefix.length)
  }
  const make = (index: number, length: number) => ({
    type: 'user/message',
    data: { content: [{ type: 'text', text: text(index, length) }], source: { kind: 'user' } },
  })
  // 第 0 条最短、第 24 条次短，中间长度递增；期望：首尾保留，中间 18 条取最长的（index 6..23）
  const events = Array.from({ length: 25 }, (_, index) => make(index, index === 0 ? 20 : index === 24 ? 30 : 50 + index))
  const ctx = fakeCtx({ 's-1': events })
  const questions = await readSessionUserQuestions(ctx, 's-1')
  assert.equal(questions.length, 20)
  assert.equal(questions[0], text(0, 20))
  assert.equal(questions.at(-1), text(24, 30))
  for (let index = 1; index <= 5; index += 1) assert.ok(!questions.includes(text(index, 50 + index)), `q${index} should be dropped`)
  for (let index = 6; index <= 23; index += 1) assert.ok(questions.includes(text(index, 50 + index)), `q${index} should be kept`)
})

test('readSessionUserQuestions keeps chronological order when at most 20 questions', async () => {
  const make = (index: number) => ({
    type: 'user/message',
    data: { content: [{ type: 'text', text: `q${index}` }], source: { kind: 'user' } },
  })
  const ctx = fakeCtx({ 's-1': Array.from({ length: 20 }, (_, index) => make(index)) })
  const questions = await readSessionUserQuestions(ctx, 's-1')
  assert.deepEqual(questions, Array.from({ length: 20 }, (_, index) => `q${index}`))
})

test('attachSessionQuestions caps a session at 1200 chars of questions', async () => {
  const many = Array.from({ length: 8 }, () => ({
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'x'.repeat(240) }], source: { kind: 'user' } },
  }))
  const ctx = fakeCtx({ 's-1': many })
  const sessions: DispatchSessionInput[] = [{ id: 's-1', workspaceId: 'ws', title: 't', lastActiveAt: 1 }]
  const [enriched] = await attachSessionQuestions(ctx, sessions)
  const questions = enriched?.userQuestions ?? []
  assert.equal(questions.length, 5)
  assert.ok(questions.reduce((sum, question) => sum + question.length, 0) <= 1200)
})

test('attachSessionQuestions keeps first and last questions even when the char cap trims', async () => {
  const many = Array.from({ length: 6 }, (_, index) => ({
    type: 'user/message',
    data: { content: [{ type: 'text', text: `q${index}-` + 'x'.repeat(235) }], source: { kind: 'user' } },
  }))
  const ctx = fakeCtx({ 's-1': many })
  const sessions: DispatchSessionInput[] = [{ id: 's-1', workspaceId: 'ws', title: 't', lastActiveAt: 1 }]
  const [enriched] = await attachSessionQuestions(ctx, sessions)
  const questions = enriched?.userQuestions ?? []
  assert.ok(questions[0]?.startsWith('q0-'))
  assert.ok(questions.at(-1)?.startsWith('q5-'))
  assert.ok(questions.reduce((sum, question) => sum + question.length, 0) <= 1200)
})

test('attachSessionQuestions leaves candidates beyond the read cap title-only', async () => {
  const ctx = fakeCtx({})
  const sessions: DispatchSessionInput[] = Array.from({ length: 61 }, (_, index) => ({ id: `s-${index}`, workspaceId: 'ws', title: `t${index}`, lastActiveAt: 61 - index }))
  const enriched = await attachSessionQuestions(ctx, sessions)
  assert.equal(enriched.length, 61)
  assert.equal(enriched[60]?.userQuestions, undefined)
})
