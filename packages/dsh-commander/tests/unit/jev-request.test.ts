import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionRequest, buildWorkspaceRequest, estimateTokens, mapChoice, mapJevAnswers } from '../../src/host/jev/request.ts'

const workspaces = [
  { id: 'ws-a', name: 'A', path: '/tmp/a', summary: 'A summary', recentSessionTitles: ['t1', 't2'] },
  { id: 'ws-b', name: 'B', path: '/tmp/b', summary: '', recentSessionTitles: [] },
]
const sessions = [
  { id: 's-1', workspaceId: 'ws-a', title: 'session one', lastActiveAt: 1000, contextUsage: 0.5 },
  { id: 's-2', workspaceId: 'ws-b', title: 'session two', lastActiveAt: 2000 },
]
const task = { title: 'task', goal: 'goal', priority: 'normal' }

test('estimateTokens uses JSON chars / 3', () => {
  assert.equal(estimateTokens('abc'), 2) // JSON.stringify → '"abc"' = 5 chars
  assert.equal(estimateTokens({ a: 'x'.repeat(30) }), Math.ceil(JSON.stringify({ a: 'x'.repeat(30) }).length / 3))
})

test('buildWorkspaceRequest keeps state to the request and puts workspace info in criteria', () => {
  const built = buildWorkspaceRequest({ model: 'jev-latest', task, workspaces })
  assert.equal(built.mode, 'workspace')
  const state = built.body.state as Record<string, unknown>
  assert.equal(state.workspaces, undefined)
  assert.deepEqual((state.task as { title: string }).title, 'task')
  assert.deepEqual(state.command, { text: '' })
  const criteria = (built.body.questions.workspace as { criteria: Record<string, { name: string; path: string; what: string; recentSessionTitles: string[] }> }).criteria
  assert.deepEqual(Object.keys(criteria), ['w_0', 'w_1'])
  assert.equal(criteria.w_0?.name, 'A')
  assert.equal(criteria.w_0?.path, '/tmp/a')
  assert.equal(criteria.w_0?.what, 'A summary')
  assert.deepEqual(criteria.w_0?.recentSessionTitles, ['t1', 't2'])
  assert.equal(criteria.w_1?.what, '未配置摘要')
  assert.equal(built.wIndex.get('ws-a'), 'w_0')
  assert.equal(built.sIndex.size, 0)
})

test('buildWorkspaceRequest caps recent session titles at 10', () => {
  const many = { ...workspaces[0]!, recentSessionTitles: Array.from({ length: 15 }, (_, index) => `t${index}`) }
  const built = buildWorkspaceRequest({ model: 'jev-latest', task, workspaces: [many] })
  const criteria = (built.body.questions.workspace as { criteria: Record<string, { recentSessionTitles: string[] }> }).criteria
  assert.equal(criteria.w_0?.recentSessionTitles.length, 10)
})

test('buildSessionRequest scopes to the chosen workspace and carries title/time in criteria', () => {
  const scoped = buildSessionRequest({ model: 'jev-latest', task, workspace: workspaces[0]!, sessions: sessions.filter((session) => session.workspaceId === 'ws-a') })
  assert.equal(scoped.mode, 'session')
  assert.equal((scoped.body.state as Record<string, unknown>).sessions, undefined)
  const criteria = (scoped.body.questions.session as { criteria: Record<string, { what: string; lastActiveAt?: string; contextUsage?: number; userQuestions?: string[] }> }).criteria
  assert.deepEqual(Object.keys(criteria), ['new', 's_0'])
  assert.equal(criteria.s_0?.what, 'session one')
  assert.equal(criteria.s_0?.lastActiveAt, new Date(1000).toISOString())
  assert.equal(criteria.s_0?.contextUsage, 0.5)
  assert.equal(scoped.sIndex.get('s-1'), 's_0')
  assert.equal(scoped.wIndex.size, 0)
})

test('buildSessionRequest adds user questions to the option description', () => {
  const withQuestions = { ...sessions[0]!, userQuestions: ['把订单导出改成流式', '顺手补个单测'] }
  const built = buildSessionRequest({ model: 'jev-latest', task, workspace: workspaces[0]!, sessions: [withQuestions] })
  const criteria = (built.body.questions.session as { criteria: Record<string, { userQuestions?: string[] }> }).criteria
  assert.deepEqual(criteria.s_0?.userQuestions, ['把订单导出改成流式', '顺手补个单测'])
})

test('mapChoice maps synthetic ids back and passes new through', () => {
  const index = new Map([['ws-a', 'w_0']])
  assert.equal(mapChoice(index, 'w_0'), 'ws-a')
  assert.equal(mapChoice(index, 'new'), 'new')
  assert.equal(mapChoice(index, 'w_9'), null)
  assert.equal(mapChoice(index, null), null)
})

test('mapJevAnswers merges the two stages into workspace/session/mode', () => {
  const wIndex = new Map([['ws-a', 'w_0'], ['ws-b', 'w_1']])
  const sIndex = new Map([['s-1', 's_0']])
  assert.deepEqual(
    mapJevAnswers({ workspace: { type: 'choice', choice: 'w_1', probabilities: {}, confidence: 1 }, session: { type: 'choice', choice: 's_0', probabilities: {}, confidence: 1 } }, wIndex, sIndex),
    { workspaceId: 'ws-b', sessionId: 's-1', mode: 'attach' },
  )
  assert.deepEqual(
    mapJevAnswers({ workspace: { type: 'choice', choice: 'w_0', probabilities: {}, confidence: 1 }, session: { type: 'choice', choice: 'new', probabilities: {}, confidence: 1 } }, wIndex, sIndex),
    { workspaceId: 'ws-a', sessionId: null, mode: 'new' },
  )
  assert.deepEqual(mapJevAnswers({}, wIndex, sIndex), { workspaceId: null, sessionId: null, mode: null })
})
