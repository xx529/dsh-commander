/**
 * Commander panel question card (ask_user_question) — renders the same
 * `PendingQuestion` instance the official composer shows and answers through
 * its `answer()` channel (waterfall or Remote reply).
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import type { PendingQuestionItem, QuestionAnswerPayload, QuestionDraft, QuestionView } from './questions'
import { buildAnswerPayload, emptyDraft, questionsComplete, questionViews, toggleOption } from './questions'

/** Locale translate function. */
export type Translate = (key: string) => string

/** One question card shown above the panel composer. */
export interface QuestionCardProps {
  item: PendingQuestionItem
  /** 0-based position inside the queue. */
  index: number
  total: number
  t: Translate
  busy: boolean
  error: string | null
  onAnswer: (answer: QuestionAnswerPayload) => void
  /** Hide this card locally (the request stays answerable in the main window). */
  onDismiss: () => void
  onOpenSession: () => void
  onPrev: () => void
  onNext: () => void
  /** Hide the queue pager when the sheet stacks every card. */
  showQueue?: boolean
}

function initialDrafts(views: readonly QuestionView[]): Record<string, QuestionDraft> {
  const drafts: Record<string, QuestionDraft> = {}
  for (const view of views) drafts[view.id] = emptyDraft()
  return drafts
}

/** Render the compact question card. */
export function QuestionCard({
  item, index, total, t, busy, error, onAnswer, onDismiss, onOpenSession, onPrev, onNext, showQueue,
}: QuestionCardProps): ReactNode {
  const views = React.useMemo(() => questionViews(item.question), [item.question])
  const [page, setPage] = React.useState(0)
  const [drafts, setDrafts] = React.useState<Record<string, QuestionDraft>>(() => initialDrafts(views))

  // A different pending question starts from an empty form.
  React.useEffect(() => {
    setPage(0)
    setDrafts(initialDrafts(views))
  }, [item.questionKey, views])

  if (views.length === 0) return null
  const safePage = Math.min(page, views.length - 1)
  const view = views[safePage] as QuestionView
  const draft = drafts[view.id] ?? emptyDraft()
  const complete = questionsComplete(views, drafts)

  const update = (mutate: (current: QuestionDraft) => QuestionDraft): void => {
    setDrafts(current => ({ ...current, [view.id]: mutate(current[view.id] ?? emptyDraft()) }))
  }
  const go = (next: number): void => { setPage(Math.min(Math.max(next, 0), views.length - 1)) }
  const skip = (): void => {
    update(current => ({ ...current, skipped: true, selected: [], custom: '' }))
    if (safePage < views.length - 1) go(safePage + 1)
  }
  const submit = (): void => {
    if (busy || !complete) return
    onAnswer(buildAnswerPayload(views, drafts))
  }

  return (
    <section className="dshc-question-card" role="dialog" aria-label={t('question.title')}>
      <header className="dshc-question-head">
        <span className="dshc-question-title">{t('question.title')}</span>
        <span className="dshc-tag">{item.commander ? t('question.commander') : t('question.workSession')}</span>
        {views.length > 1 ? (
          <span className="dshc-question-counter">
            <button type="button" className="dshc-msg-toggle" disabled={safePage <= 0} onClick={() => { go(safePage - 1) }}>‹</button>
            <span>{`${String(safePage + 1)}/${String(views.length)}`}</span>
            <button type="button" className="dshc-msg-toggle" disabled={safePage >= views.length - 1} onClick={() => { go(safePage + 1) }}>›</button>
          </span>
        ) : null}
        {total > 1 && showQueue !== false ? (
          <span className="dshc-question-queue">
            <button type="button" className="dshc-msg-toggle" disabled={index <= 0} onClick={onPrev}>‹</button>
            <span>{`${String(index + 1)}/${String(total)}`}</span>
            <button type="button" className="dshc-msg-toggle" disabled={index >= total - 1} onClick={onNext}>›</button>
          </span>
        ) : null}
        <button type="button" className="dshc-icon-button" aria-label={t('question.dismiss')} title={t('question.dismiss')} onClick={onDismiss}>
          ×
        </button>
      </header>

      <div className="dshc-question-body">
        {view.header === undefined ? null : <div className="dshc-question-label">{view.header}</div>}
        <div className="dshc-question-text">{view.question}</div>
        {view.detail === undefined ? null : <div className="dshc-question-detail">{view.detail}</div>}
        {view.options.length === 0 ? null : (
          <div className="dshc-question-options" role="group" aria-label={t('question.options')}>
            {view.options.map(option => {
              const selected = draft.selected.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  className="dshc-question-option"
                  data-selected={selected ? 'true' : 'false'}
                  aria-pressed={selected}
                  disabled={busy || draft.skipped}
                  onClick={() => { update(current => toggleOption(view, current, option.label)) }}
                >
                  <span className="dshc-question-option-label">{option.label}</span>
                  {option.description === undefined ? null : <span className="dshc-question-option-desc">{option.description}</span>}
                </button>
              )
            })}
          </div>
        )}
        {view.multiSelect ? <div className="dshc-question-hint">{t('question.multiHint')}</div> : null}
        <textarea
          className="dshc-field-textarea dshc-question-custom"
          value={draft.custom}
          disabled={busy || draft.skipped}
          placeholder={t('question.customPlaceholder')}
          aria-label={t('question.customPlaceholder')}
          onChange={event => {
            const custom = event.target.value
            update(current => ({ ...current, custom, skipped: false }))
          }}
        />
      </div>

      {error === null ? null : <div className="dshc-question-error" role="alert">{error}</div>}

      <div className="dshc-question-actions">
        <button type="button" className="dshc-button" data-variant="ghost" data-size="sm" disabled={busy} onClick={skip}>
          {t('question.skip')}
        </button>
        <button type="button" className="dshc-button" data-variant="ghost" data-size="sm" onClick={onOpenSession}>
          {t('question.openSession')}
        </button>
        <button
          type="button"
          className="dshc-button"
          data-variant="primary"
          data-size="sm"
          disabled={busy || !complete}
          onClick={submit}
        >
          {busy ? t('question.submitting') : t('question.submit')}
        </button>
      </div>
    </section>
  )
}
