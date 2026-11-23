// 回归：client 软依赖（uiWorkspace/uiSession）晚于本插件激活时，看板「打开会话」与审批卡不能永久缺失。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLazySessionStatus, createOpenSession } from '../../src/client/lazy-services.ts'
import type { SessionStatusMap } from '../../src/client/approval.ts'

test('openSession 在点击时解析 uiWorkspace（provider 晚到也能用）', () => {
  const opened: string[] = []
  let service: { openSession(sessionId: string): void } | undefined
  const ctx = { get: (name: string) => (name === 'uiWorkspace' ? service : undefined) } as never
  const open = createOpenSession(ctx)
  open('s1') // provider 未就绪：不抛、不崩
  service = { openSession: (sessionId) => opened.push(sessionId) }
  open('s1')
  assert.deepEqual(opened, ['s1'])
})

test('openSession 服务缺失时不抛（只告警一次），空 sessionId 直接忽略', () => {
  const ctx = { get: () => undefined } as never
  const open = createOpenSession(ctx)
  assert.doesNotThrow(() => {
    open('')
    open('s1')
    open('s2')
  })
})

test('lazy sessionStatus：uiSession 晚到时挂上观察源并唤醒订阅者', () => {
  const status: SessionStatusMap = new Map([['s1', { running: true }]])
  let innerListeners: Array<() => void> = []
  let service: { sessionStatus: { getSnapshot(): SessionStatusMap; subscribe(listener: () => void): () => void } } | undefined
  const ctx = { get: (name: string) => (name === 'uiSession' ? service : undefined) } as never
  const source = createLazySessionStatus(ctx)
  let notified = 0
  const unsubscribe = source.subscribe(() => { notified += 1 })
  assert.equal(source.getSnapshot().size, 0) // provider 未就绪：稳定空快照
  service = {
    sessionStatus: {
      getSnapshot: () => status,
      subscribe: (listener) => { innerListeners.push(listener); return () => { innerListeners = innerListeners.filter(item => item !== listener) } },
    },
  }
  source.refresh()
  assert.equal(notified, 1, 'provider 到位后应唤醒订阅者')
  assert.equal(source.getSnapshot().get('s1')?.running, true)
  for (const listener of [...innerListeners]) listener()
  assert.equal(notified, 2, '内层状态变化应转发给订阅者')
  unsubscribe()
  assert.equal(innerListeners.length, 0, '最后一个订阅者退订时释放内层订阅')
})
