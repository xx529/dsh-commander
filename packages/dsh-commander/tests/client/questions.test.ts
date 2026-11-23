import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAnswerPayload, emptyDraft, isQuestionLike, questionsComplete, questionViews, selectPendingQuestions, toggleOption,
} from '../../src/client/questions.ts'

const pendingQuestion = (overrides: Record<string, unknown> = {}) => ({
  kind: 'question',
  key: 'question:sess-work:call_1',
  sessionId: 'sess-work',
  callId: 'call_1',
  questions: [{
    id: 'q1',
    question: '这一轮你想让我做什么？',
    header: '下一步',
    options: [{ label: '派发新的调研任务', description: '建卡并派发' }, { label: '跟进 DSH 升级' }],
  }],
  answer: async () => {},
  ...overrides,
})

test('isQuestionLike only accepts answerable question projections', () => {
  assert.equal(isQuestionLike(pendingQuestion()), true)
  assert.equal(isQuestionLike({ ...pendingQuestion(), kind: 'approval' }), false)
  assert.equal(isQuestionLike({ ...pendingQuestion(), questions: [] }), false)
  assert.equal(isQuestionLike({ ...pendingQuestion(), answer: undefined }), false)
  assert.equal(isQuestionLike(null), false)
})

test('selectPendingQuestions puts the commander session first and dedupes keys', () => {
  const statuses = new Map<string, { pendingInteraction?: unknown }>([
    ['session-commander', { pendingInteraction: pendingQuestion({ key: 'question:cmd:c1', sessionId: 'session-commander' }) }],
    ['sess-work', { pendingInteraction: pendingQuestion() }],
  ])
  const items = selectPendingQuestions(statuses, [
    { sessionId: 'sess-work', taskId: 'task_1', title: '导出会话' },
    { sessionId: 'sess-work', taskId: 'task_1', title: '导出会话' },
  ], 'session-commander')
  assert.deepEqual(items.map(item => [item.sessionId, item.commander]), [
    ['session-commander', true],
    ['sess-work', false],
  ])
  assert.equal(items[1]?.taskId, 'task_1')
  assert.equal(items[1]?.title, '导出会话')
})

test('questionViews normalizes options and drops malformed questions', () => {
  const views = questionViews(pendingQuestion({
    questions: [
      { id: 'q1', question: '去哪个工作区？', options: [{ label: 'Research', description: '调研' }, { label: '' }, { bad: true }] },
      { id: 'q2' },
      { question: '没有 id' },
    ],
  }))
  assert.deepEqual(views, [{
    id: 'q1',
    question: '去哪个工作区？',
    options: [{ label: 'Research', description: '调研' }],
    multiSelect: false,
  }])
})

test('toggleOption enforces single-select and supports multi-select', () => {
  const single = { id: 'q1', question: 'q', options: [], multiSelect: false }
  const multi = { ...single, multiSelect: true }
  assert.deepEqual(toggleOption(single, emptyDraft(), 'A').selected, ['A'])
  assert.deepEqual(toggleOption(single, { selected: ['A'], custom: '', skipped: false }, 'B').selected, ['B'])
  assert.deepEqual(toggleOption(multi, emptyDraft(), 'A').selected, ['A'])
  assert.deepEqual(toggleOption(multi, { selected: ['A'], custom: '', skipped: false }, 'B').selected, ['A', 'B'])
  assert.deepEqual(toggleOption(multi, { selected: ['A', 'B'], custom: '', skipped: false }, 'A').selected, ['B'])
})

test('buildAnswerPayload encodes skip, single-select custom, and multi-select custom', () => {
  const views = questionViews(pendingQuestion({
    questions: [
      { id: 'q1', question: '单选', options: [{ label: 'A' }] },
      { id: 'q2', question: '跳过' },
      { id: 'q3', question: '多选', options: [{ label: 'X' }], multiSelect: true },
      { id: 'q4', question: '自由文本' },
    ],
  }))
  const drafts = {
    q1: { selected: ['A'], custom: '补充说明', skipped: false },
    q2: { selected: [], custom: '', skipped: true },
    q3: { selected: ['X'], custom: '再加一句', skipped: false },
    q4: { selected: [], custom: '只说这个', skipped: false },
  }
  assert.deepEqual(buildAnswerPayload(views, drafts), {
    answers: [
      { id: 'q1', selected: [], custom: '补充说明' },
      { id: 'q2', selected: [] },
      { id: 'q3', selected: ['X'], custom: '再加一句' },
      { id: 'q4', selected: [], custom: '只说这个' },
    ],
  })
  assert.equal(questionsComplete(views, drafts), true)
  assert.equal(questionsComplete(views, { ...drafts, q2: emptyDraft() }), false)
  assert.equal(questionsComplete(views, { ...drafts, q4: { selected: [], custom: '  ', skipped: false } }), false)
})
