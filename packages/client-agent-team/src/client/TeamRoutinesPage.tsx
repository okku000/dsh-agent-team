import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamDeleteRoutineRequest,
  AgentTeamDeleteRoutineResult,
  AgentTeamMembersRequest,
  AgentTeamRoutine,
  AgentTeamRoutinesRequest,
  AgentTeamRoutinesResult,
  AgentTeamSaveRoutineRequest,
  AgentTeamSaveRoutineResult,
} from '@wowyuarm/dsh-agent-team/types'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { formatAbsoluteTime, formatInboxTime } from './team-formatters.ts'
import createCss from './create.module.css'
import css from './conversation.module.css'
import routinesCss from './routines.module.css'

/** The declaration shape a routine is written and read as. */
type RoutineDeclaration = AgentTeamRoutine['declaration']

interface TeamRoutinesPageProps {
  readonly useWorkspaces: TeamConversationProps['useWorkspaces']
  readonly loadRoutines: (request: AgentTeamRoutinesRequest) => Promise<RemoteResult<AgentTeamRoutinesResult>>
  readonly saveRoutine: (request: AgentTeamSaveRoutineRequest) => Promise<RemoteResult<AgentTeamSaveRoutineResult>>
  readonly deleteRoutine: (request: AgentTeamDeleteRoutineRequest) => Promise<RemoteResult<AgentTeamDeleteRoutineResult>>
  /** The global Member catalog: a routine names one Member, so the editor picks one instead of taking a typed handle. */
  readonly loadMembers: (request: AgentTeamMembersRequest) => Promise<RemoteResult<readonly AgentTeamClientMemberStatus[]>>
  readonly t: TeamConversationProps['t']
}

/**
 * The Host's own schedule, on one global surface.
 *
 * Routines are Host configuration rather than Workspace content: the same list
 * answers for every Workspace, and a routine names one Agent Member and one
 * instruction — it never picks a Channel, a Thread, or a Message. That is why
 * this page is the Inbox's sibling rather than a Channel's: it crosses
 * Workspaces, it belongs to no Channel, and an Agent Member reaches the same
 * store through the `team_routine` tool.
 *
 * The one Workspace on every request is a fence, not a scope: the Host answers
 * the schedule only to a caller bound to a Workspace that exists, and the
 * schedule it answers with is the Host's whole list. The page takes the first
 * visible Workspace for that and shows the reader the schedule, not a slice.
 *
 * A routine save emits no Team `changes` event — it is configuration, not a
 * ledger fact — so this page re-reads on open and after its own saves and
 * deletes rather than waiting for a wake that will never come.
 */
export function TeamRoutinesPage({ useWorkspaces, loadRoutines, saveRoutine, deleteRoutine, loadMembers, t }: TeamRoutinesPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  /** The authorizing fence; `undefined` means the Host has no Workspace to answer through yet. */
  const authorization = workspaces[0]?.workspaceId
  const [routines, setRoutines] = useState<readonly AgentTeamRoutine[]>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [editor, setEditor] = useState<{ readonly routine?: AgentTeamRoutine }>()
  const [confirming, setConfirming] = useState<AgentTeamRoutine>()
  const [deleting, setDeleting] = useState(false)

  const refresh = useCallback(async () => {
    if (authorization === undefined) {
      setRoutines([])
      setLoading(false)
      return
    }
    const result = await loadRoutines({ workspaceId: authorization })
    if (!result.ok) {
      setError(result.error.message)
      setLoading(false)
      return
    }
    setRoutines(result.value.routines)
    setError(undefined)
    setLoading(false)
  }, [authorization, loadRoutines])

  useEffect(() => { void refresh() }, [refresh])

  // One catalog call, no Workspace: the picker offers every Member the Human can
  // reach, because a routine may wake one that shares no Channel with this page.
  useEffect(() => {
    void (async () => {
      const result = await loadMembers({})
      if (!result.ok) return
      setMembers(result.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived'))
    })()
  }, [loadMembers])

  // The stored target is a branded Member id; the roster is what turns it back
  // into the handle a reader recognizes.
  const byId = useMemo(() => new Map<string, AgentTeamClientMemberStatus>(members.map(status => [status.member.memberId as string, status])), [members])

  const remove = async (routine: AgentTeamRoutine): Promise<void> => {
    if (authorization === undefined) return
    setDeleting(true)
    const result = await deleteRoutine({ workspaceId: authorization, name: routine.name })
    setDeleting(false)
    if (!result.ok) {
      setConfirming(undefined)
      setError(result.error.message)
      return
    }
    setConfirming(undefined)
    await refresh()
  }

  const count = routines?.length ?? 0
  return <main className={css.surface} data-team-routines>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('routinesTitle')}</h1>
          {routines !== undefined && <p className={routinesCss.headerMeta}>
            <span className={routinesCss.headerCount}>{t('routinesCount', { count })}</span>
            {' · '}
            {t('routinesHint')}
          </p>}
        </div>
        <Button size="sm" variant="primary" disabled={members.length === 0 || authorization === undefined} onClick={() => { setEditor({}) }}>{t('routinesNew')}</Button>
      </header>
    </div>
    <div className={css.timeline}>
      <div className={css.timelineContent}>
        {loading && routines === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('routinesLoading')}</p></div>}
        {!loading && routines === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button></div>}
        {routines !== undefined && (count === 0
          ? <div className={css.emptySurface}>
              <div className={css.emptyState}>
                <strong>{t('routinesEmptyTitle')}</strong>
                <span>{authorization === undefined ? t('routinesNoWorkspace') : t('routinesEmptyHint')}</span>
              </div>
            </div>
          : <div className={routinesCss.list}>
              {routines.map(routine => <RoutineCard
                key={routine.name}
                routine={routine}
                handle={routine.declaration.member === undefined ? undefined : byId.get(routine.declaration.member)?.member.handle}
                t={t}
                onEdit={() => { setEditor({ routine }) }}
                onDelete={() => { setConfirming(routine) }}
              />)}
            </div>)}
        {routines !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </div>
    {editor !== undefined && <RoutineEditor
      {...(editor.routine === undefined ? {} : { routine: editor.routine })}
      members={members}
      onClose={() => { setEditor(undefined) }}
      save={async declaration => {
        if (authorization === undefined) return t('routinesNoWorkspace')
        const result = await saveRoutine({ workspaceId: authorization, routine: declaration })
        // A declaration the Host cannot run is refused whole, so the editor stays
        // open with the Host's own reason and the running routines stay as they are.
        if (!result.ok) return result.error.message
        setEditor(undefined)
        await refresh()
        return undefined
      }}
      t={t}
    />}
    {confirming !== undefined && <Modal
      open
      onClose={() => { setConfirming(undefined) }}
      title={t('routinesDeleteTitle', { name: confirming.name })}
      description={t('routinesDeleteNotice')}
      closeLabel={t('close')}
      footer={<>
        <Button variant="outline" disabled={deleting} onClick={() => { setConfirming(undefined) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={deleting} onClick={() => { void remove(confirming) }}>{deleting ? t('routinesDeleting') : t('routinesDelete')}</Button>
      </>}
    >
      <p className={routinesCss.meta}>{t('routinesDeleteHint')}</p>
    </Modal>}
  </main>
}

/**
 * One routine. The card answers, in reading order, the four questions a
 * schedule has to answer: what is it, when does it fire, who does it wake and
 * what does it say, and who asked for it. Only a stored routine is editable —
 * an operator's own `config.routines` declaration belongs to their profile
 * file, and offering an edit the Host would refuse is worse than saying so.
 */
function RoutineCard({ routine, handle, t, onEdit, onDelete }: {
  readonly routine: AgentTeamRoutine
  readonly handle: string | undefined
  readonly t: TeamConversationProps['t']
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  const { declaration } = routine
  const stored = routine.origin === 'store'
  const attribution = routine.updatedBy ?? routine.createdBy
  const attributionAt = routine.updatedAt ?? routine.createdAt
  return <article className={routinesCss.card} data-origin={routine.origin}>
    <div className={routinesCss.cardHead}>
      <span className={routinesCss.name} title={declaration.name}>{declaration.name}</span>
      {!stored && <span className={routinesCss.origin}>{t('routinesOriginConfig')}</span>}
      {stored && <span className={routinesCss.actions}>
        <Button size="sm" variant="outline" onClick={onEdit}>{t('routinesEdit')}</Button>
        <Button size="sm" variant="outline" onClick={onDelete}>{t('routinesDelete')}</Button>
      </span>}
    </div>
    <span className={routinesCss.trigger}>{describeTrigger(declaration, t)}</span>
    {/* The wake target is what a routine is FOR, so it speaks in the schedule's
        own ink and carries the handle the roster knows rather than the id the
        store holds; a target the roster no longer has falls back to the
        declaration, because that is the truth the Host will fire at. */}
    <span className={routinesCss.target} title={declaration.member}>{t('routinesWakes', { member: handle === undefined ? declaration.member : `@${handle}` })}</span>
    <span className={routinesCss.prompt} title={declaration.prompt}>{declaration.prompt}</span>
    <span className={routinesCss.meta} title={attributionAt === undefined ? undefined : formatAbsoluteTime(attributionAt)}>
      {attribution === undefined || attributionAt === undefined
        ? t('routinesOriginConfigMeta')
        : t(routine.updatedBy === undefined ? 'routinesCreatedBy' : 'routinesUpdatedBy', { name: `@${attribution.handle}`, time: formatInboxTime(attributionAt, t) })}
    </span>
  </article>
}

/**
 * The routine editor. The name is the identity — a save upserts in place — so
 * editing one keeps its name fixed and creating one asks for it, and both forms
 * validate what the Host validates before the save is attempted, so a refusal
 * that is the reader's to fix is answered here instead of as a remote error.
 */
function RoutineEditor({ routine, members, onClose, save, t }: {
  readonly routine?: AgentTeamRoutine
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly onClose: () => void
  readonly save: (declaration: RoutineDeclaration) => Promise<string | undefined>
  readonly t: TeamConversationProps['t']
}) {
  const declaration = routine?.declaration
  const [name, setName] = useState(declaration?.name ?? '')
  const [member, setMember] = useState(declaration?.member ?? members[0]?.member.memberId ?? '')
  const [prompt, setPrompt] = useState(declaration?.prompt ?? '')
  const [summary, setSummary] = useState(declaration?.summary ?? '')
  const [trigger, setTrigger] = useState<'everySeconds' | 'at'>(declaration?.at === undefined ? 'everySeconds' : 'at')
  const [everySeconds, setEverySeconds] = useState(declaration?.everySeconds === undefined ? '3600' : String(declaration.everySeconds))
  const [at, setAt] = useState(declaration?.at ?? '')
  const [anchorAt, setAnchorAt] = useState(declaration?.anchorAt ?? '')
  const [once, setOnce] = useState(declaration?.once === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const parsed = validate({ name, member, prompt, summary, trigger, everySeconds, at, anchorAt, once }, t)
    if (typeof parsed === 'string') {
      setError(parsed)
      return
    }
    setSaving(true)
    const refused = await save(parsed)
    setSaving(false)
    if (refused !== undefined) setError(refused)
  }

  return <Modal
    open
    onClose={onClose}
    title={routine === undefined ? t('routinesCreateTitle') : t('routinesEditTitle')}
    description={routine === undefined ? t('routinesCreateNotice') : routine.name}
    closeLabel={t('close')}
    contentClassName={createCss.dialogContent!}
    footer={<>
      <Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
      <Button type="submit" form="team-routine-form" variant="primary" disabled={saving}>{saving ? t('routinesSaving') : t('routinesSave')}</Button>
    </>}
  >
    <form id="team-routine-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
      <label className={createCss.field}>
        <span>{t('routinesName')}</span>
        <Input className={createCss.input!} value={name} placeholder={t('routinesNamePlaceholder')} disabled={saving || routine !== undefined} autoFocus={routine === undefined} onChange={event => { setName(event.target.value) }} />
      </label>
      <label className={createCss.field}>
        <span>{t('routinesMember')}</span>
        <select className={routinesCss.select} value={member} disabled={saving} onChange={event => { setMember(event.target.value) }}>
          {members.map(status => <option key={status.member.memberId} value={status.member.memberId}>
            {`@${status.member.handle}${status.availability === 'active' ? '' : ` · ${t('statusUnavailable')}`}`}
          </option>)}
        </select>
      </label>
      <label className={createCss.field}>
        <span>{t('routinesPrompt')}</span>
        <textarea className={routinesCss.textarea} value={prompt} placeholder={t('routinesPromptPlaceholder')} disabled={saving} onChange={event => { setPrompt(event.target.value) }} />
      </label>
      <label className={createCss.field}>
        <span>{t('routinesSummary')}</span>
        <Input className={createCss.input!} value={summary} placeholder={t('routinesSummaryPlaceholder')} disabled={saving} onChange={event => { setSummary(event.target.value) }} />
      </label>
      <div className={createCss.field}>
        <span>{t('routinesTrigger')}</span>
        <div className={routinesCss.radios}>
          <label className={routinesCss.radio}>
            <input type="radio" name="team-routine-trigger" checked={trigger === 'everySeconds'} disabled={saving} onChange={() => { setTrigger('everySeconds') }} />
            <span>{t('routinesTriggerRepeat')}</span>
          </label>
          <label className={routinesCss.radio}>
            <input type="radio" name="team-routine-trigger" checked={trigger === 'at'} disabled={saving} onChange={() => { setTrigger('at') }} />
            <span>{t('routinesTriggerOnce')}</span>
          </label>
        </div>
      </div>
      {trigger === 'everySeconds'
        ? <>
            <div className={routinesCss.pair}>
              <label className={createCss.field}>
                <span>{t('routinesEverySeconds')}</span>
                <Input className={createCss.input!} value={everySeconds} inputMode="numeric" disabled={saving} onChange={event => { setEverySeconds(event.target.value) }} />
              </label>
              <label className={createCss.field}>
                <span>{t('routinesAnchorAt')}</span>
                <Input className={createCss.input!} value={anchorAt} placeholder={t('routinesInstantPlaceholder')} disabled={saving} onChange={event => { setAnchorAt(event.target.value) }} />
              </label>
            </div>
            <Checkbox checked={once} disabled={saving} label={t('routinesStopAfterFirst')} onChange={setOnce} />
          </>
        : <label className={createCss.field}>
            <span>{t('routinesAt')}</span>
            <Input className={createCss.input!} value={at} placeholder={t('routinesInstantPlaceholder')} disabled={saving} onChange={event => { setAt(event.target.value) }} />
          </label>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
    </form>
  </Modal>
}

/** RFC 3339 with an explicit offset or `Z`; a bare local time is refused by the Host too. */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
/** Mirrors the Host's own floor, so the reader is told before the round trip. */
const MIN_INTERVAL_SECONDS = 60

interface RoutineDraft {
  readonly name: string
  readonly member: string
  readonly prompt: string
  readonly summary: string
  readonly trigger: 'everySeconds' | 'at'
  readonly everySeconds: string
  readonly at: string
  readonly anchorAt: string
  readonly once: boolean
}

/**
 * Validate one draft the way the Host validates a declaration, and answer the
 * declaration to save or the message to show. It mirrors the Host's rules
 * rather than replacing them: the save still sends the result, and anything the
 * Host refuses comes back as the Host's own reason.
 */
function validate(draft: RoutineDraft, t: TeamConversationProps['t']): RoutineDeclaration | string {
  if (!NAME_PATTERN.test(draft.name)) return t('routinesErrorName')
  if (draft.member.trim() === '') return t('routinesErrorMember')
  if (draft.prompt.trim() === '') return t('routinesErrorPrompt')
  if (draft.trigger === 'everySeconds') {
    const seconds = Number(draft.everySeconds)
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS) return t('routinesErrorInterval')
    if (draft.anchorAt.trim() !== '' && !INSTANT_PATTERN.test(draft.anchorAt.trim())) return t('routinesErrorInstant')
    return {
      name: draft.name,
      member: draft.member,
      prompt: draft.prompt.trim(),
      ...(draft.summary.trim() === '' ? {} : { summary: draft.summary.trim() }),
      once: draft.once,
      everySeconds: seconds,
      ...(draft.anchorAt.trim() === '' ? {} : { anchorAt: draft.anchorAt.trim() }),
    }
  }
  if (!INSTANT_PATTERN.test(draft.at.trim())) return t('routinesErrorInstant')
  return {
    name: draft.name,
    member: draft.member,
    prompt: draft.prompt.trim(),
    ...(draft.summary.trim() === '' ? {} : { summary: draft.summary.trim() }),
    once: false,
    at: draft.at.trim(),
  }
}

/**
 * One routine's schedule in the reader's terms. The declaration keeps an
 * instant as the absolute string it was written as, so the line repeats that
 * rather than re-localizing it: a reader who wrote `+09:00` sees the instant
 * they meant, and one who wrote `Z` sees that.
 */
function describeTrigger(declaration: RoutineDeclaration, t: TeamConversationProps['t']): string {
  if (declaration.at !== undefined) return t('routinesAtSummary', { at: declaration.at })
  const parts = [t('routinesEverySummary', { seconds: declaration.everySeconds ?? 0 })]
  if (declaration.anchorAt !== undefined) parts.push(t('routinesAnchorSummary', { at: declaration.anchorAt }))
  parts.push(declaration.once ? t('routinesOnceSummary') : t('routinesRepeatSummary'))
  return parts.join(' · ')
}
