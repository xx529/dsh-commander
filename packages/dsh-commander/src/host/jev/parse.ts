// Jev 响应解析与打分（纯函数，可单测）。契约：ARCHITECTURE §5.4 + m1-contract-patch §1.2/§1.3。
export interface JevChoiceAnswer {
  type: 'choice'
  choice: string | null
  probabilities: Record<string, number>
  confidence: number
}

export interface JevAnswers {
  workspace?: JevChoiceAnswer
  session?: JevChoiceAnswer
}

export interface JevParsedResponse {
  model?: string
  answers: JevAnswers
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface JevScores {
  pWorkspace: number
  pSession: number
  pMax: number
  concentration: number
}

export type JevParseResult = { ok: true; response: JevParsedResponse } | { ok: false; code: 'bad_response'; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 把 Jev 原始 JSON 归一化为 answers（兼容 answers/result.answers/data.answers 与缺省概率）。 */
export function parseJevResponse(json: unknown): JevParseResult {
  const container = isRecord(json) ? json : {}
  const candidate =
    (isRecord(container.answers) && container.answers) ||
    (isRecord(container.result) && isRecord(container.result.answers) && container.result.answers) ||
    (isRecord(container.data) && isRecord(container.data.answers) && container.data.answers) ||
    null
  if (candidate === null) return { ok: false, code: 'bad_response', message: 'responses has no answers object' }
  const normalize = (raw: unknown): JevChoiceAnswer | undefined => {
    if (!isRecord(raw)) return undefined
    const choice = typeof raw.choice === 'string' ? raw.choice : null
    const probabilitiesSource = isRecord(raw.probabilities) ? raw.probabilities : {}
    const probabilities: Record<string, number> = {}
    for (const [key, value] of Object.entries(probabilitiesSource)) {
      if (typeof value === 'number' && Number.isFinite(value)) probabilities[key] = value
    }
    const confidenceRaw = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0
    return { type: 'choice', choice, probabilities, confidence: Math.min(1, Math.max(0, confidenceRaw)) }
  }
  const answers: JevAnswers = {}
  const workspace = normalize(candidate.workspace)
  const session = normalize(candidate.session)
  if (workspace !== undefined) answers.workspace = workspace
  if (session !== undefined) answers.session = session
  if (answers.workspace === undefined && answers.session === undefined) {
    return { ok: false, code: 'bad_response', message: 'answers object has neither workspace nor session' }
  }
  const usage = isRecord(container.usage) ? container.usage : undefined
  return {
    ok: true,
    response: {
      ...(typeof container.model === 'string' ? { model: container.model } : {}),
      answers,
      ...(usage !== undefined
        ? {
            usage: {
              ...(typeof usage.input_tokens === 'number' ? { input_tokens: usage.input_tokens } : {}),
              ...(typeof usage.output_tokens === 'number' ? { output_tokens: usage.output_tokens } : {}),
            },
          }
        : {}),
    },
  }
}

/** 某个 choice answer 的 top 概率（缺失为 0）。 */
export function topProbability(answer: JevChoiceAnswer | undefined): number {
  if (answer === undefined || answer.choice === null) return 0
  return answer.probabilities[answer.choice] ?? 0
}

/** 打分：pMax=min(pW,pS)，concentration=min(cW,cS)（ARCHITECTURE §5.4）。 */
export function computeJevScores(answers: JevAnswers): JevScores {
  const pWorkspace = topProbability(answers.workspace)
  const pSession = topProbability(answers.session)
  const cWorkspace = answers.workspace?.confidence ?? 0
  const cSession = answers.session?.confidence ?? 0
  return {
    pWorkspace,
    pSession,
    pMax: Math.min(pWorkspace, pSession),
    concentration: Math.min(cWorkspace, cSession),
  }
}
