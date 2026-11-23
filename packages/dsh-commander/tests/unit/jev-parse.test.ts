import test from 'node:test'
import assert from 'node:assert/strict'
import { computeJevScores, parseJevResponse, topProbability } from '../../src/host/jev/parse.ts'

test('parseJevResponse normalizes answers/probabilities/confidence', () => {
  const parsed = parseJevResponse({
    model: 'jev-1.14.0',
    answers: {
      workspace: { type: 'choice', choice: 'w_1', probabilities: { w_0: 0.2, w_1: 0.7, bad: 'x' }, confidence: 0.9 },
      session: { type: 'choice', choice: 'new', probabilities: { new: 0.6 }, confidence: 1.4 },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.response.model, 'jev-1.14.0')
  assert.equal(parsed.response.answers.workspace?.choice, 'w_1')
  assert.deepEqual(parsed.response.answers.workspace?.probabilities, { w_0: 0.2, w_1: 0.7 })
  assert.equal(parsed.response.answers.session?.confidence, 1) // clamp
  assert.deepEqual(parsed.response.usage, { input_tokens: 10, output_tokens: 2 })
})

test('parseJevResponse accepts result.answers / data.answers variants', () => {
  const resultVariant = parseJevResponse({ result: { answers: { workspace: { choice: 'a', probabilities: { a: 1 }, confidence: 0.5 } } } })
  assert.equal(resultVariant.ok, true)
  const dataVariant = parseJevResponse({ data: { answers: { session: { choice: 'new', probabilities: { new: 1 }, confidence: 0.5 } } } })
  assert.equal(dataVariant.ok, true)
})

test('parseJevResponse rejects responses without answers', () => {
  const parsed = parseJevResponse({ foo: 'bar' })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.equal(parsed.code, 'bad_response')
})

test('topProbability returns 0 for missing choice/probability', () => {
  assert.equal(topProbability(undefined), 0)
  assert.equal(topProbability({ type: 'choice', choice: 'x', probabilities: {}, confidence: 0.5 }), 0)
  assert.equal(topProbability({ type: 'choice', choice: 'x', probabilities: { x: 0.42 }, confidence: 0.5 }), 0.42)
})

test('computeJevScores takes min of probabilities and confidences', () => {
  const scores = computeJevScores({
    workspace: { type: 'choice', choice: 'w', probabilities: { w: 0.8 }, confidence: 0.7 },
    session: { type: 'choice', choice: 's', probabilities: { s: 0.6 }, confidence: 0.9 },
  })
  assert.deepEqual(scores, { pWorkspace: 0.8, pSession: 0.6, pMax: 0.6, concentration: 0.7 })
})
