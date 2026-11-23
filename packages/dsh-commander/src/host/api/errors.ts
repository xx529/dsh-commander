// /commander/* 错误 envelope：{ok:false, code, message, field?}（implementation-plan §8.5 + m0-contract-patch 新增码）。
export const API_ERROR_CODES = [
  'invalid_request',
  'not_found',
  'conflict',
  'panel_unavailable',
  'storage_error',
  'internal',
  'binding_required',
  'binding_broken',
  'prompt_failed',
  'workspace_conflict',
  'preset_unknown',
  'create_failed',
  'unknown_workspace',
  'decision_expired',
  'decision_required',
  'delivery_failed',
  'rotation_disabled',
  'rotation_busy',
  'rotation_failed',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export const API_ERROR_HTTP: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  panel_unavailable: 503,
  storage_error: 500,
  internal: 500,
  binding_required: 409,
  binding_broken: 409,
  prompt_failed: 502,
  workspace_conflict: 409,
  preset_unknown: 400,
  create_failed: 502,
  unknown_workspace: 400,
  decision_expired: 409,
  decision_required: 409,
  delivery_failed: 502,
  rotation_disabled: 409,
  rotation_busy: 409,
  rotation_failed: 502,
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly field: string | undefined
  readonly retryable: boolean | undefined
  constructor(code: ApiErrorCode, message: string, options: { field?: string; retryable?: boolean } = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.field = options.field
    this.retryable = options.retryable
  }
}

export interface ApiErrorBody {
  ok: false
  code: ApiErrorCode
  message: string
  field?: string
  retryable?: boolean
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  const message = String((error as Error)?.message ?? error)
  return new ApiError('internal', message.slice(0, 300))
}

export function errorBody(error: ApiError): ApiErrorBody {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.field !== undefined ? { field: error.field } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
  }
}
