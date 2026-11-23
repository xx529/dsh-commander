// 纯函数门控：计算 pass 与 reason。M1 全确认模式下 gate 只用于 scores/recommendation 展示，不用于放行。
// 契约：ARCHITECTURE §5.4（v2.6：两段阈值独立，取消置信度下限）。
import type { JevScores } from '../jev/parse.ts'

export type GateReason = 'pass' | 'low_pworkspace' | 'low_psession' | 'low_confidence' | 'conflict' | 'jev_unavailable'

export interface GateInput {
  scores: JevScores
  conflict: boolean
  jevOk: boolean
  /** 工作区段阈值（pWorkspace）。 */
  pWorkspaceThreshold: number
  /** 会话段阈值（pSession）。 */
  pSessionThreshold: number
}

export interface GateResult {
  pass: boolean
  reason: GateReason
}

/** 门控判定（阈值来自 ConfigRecord.jev；全确认模式恒不放行，但保留纯函数供未来与展示）。 */
export function evaluateGate(input: GateInput): GateResult {
  if (!input.jevOk) return { pass: false, reason: 'jev_unavailable' }
  if (input.conflict) return { pass: false, reason: 'conflict' }
  if (input.scores.pWorkspace < input.pWorkspaceThreshold) return { pass: false, reason: 'low_pworkspace' }
  if (input.scores.pSession < input.pSessionThreshold) return { pass: false, reason: 'low_psession' }
  return { pass: true, reason: 'pass' }
}

/** M1 全确认：presentationReason 只影响确认卡文案，不改变"必须确认"。 */
export function needsConfirmationReason(input: { jevOk: boolean; scores: JevScores; pWorkspaceThreshold: number; pSessionThreshold: number }): 'jev_unavailable' | 'low_confidence' | 'user_confirm_required' {
  if (!input.jevOk) return 'jev_unavailable'
  const low = input.scores.pWorkspace < input.pWorkspaceThreshold || input.scores.pSession < input.pSessionThreshold
  return low ? 'low_confidence' : 'user_confirm_required'
}
