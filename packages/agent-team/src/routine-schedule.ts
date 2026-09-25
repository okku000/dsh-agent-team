/**
 * Schedule arithmetic and the configuration contract of the Team's routine
 * producer (`./routines.ts`).
 *
 * A routine is one thing the Host does on a schedule. Two actions are declared
 * here and a routine does exactly one of them:
 *
 * - `wake` (the default) injects an instruction into one named Member's own
 *   Session — the Member acts, and nothing reaches the Team ledger.
 * - `post` commits one Message into one named Channel as the Human, where a
 *   body mention is what wakes the Members it names: the notification carries
 *   the message body, so a mentioned Member reads the instruction and starts a
 *   turn without any second delivery lane.
 *
 * Everything here is pure: validation, the next-instant math, and the strings
 * the Member and the fire log read. Keeping cordis and I/O out of this module is
 * what lets the schedule be tested at its boundaries — an instant that already
 * passed, an anchored interval across a restart, a target written as an id or as
 * a handle — without a Host.
 *
 * Shape mistakes throw while the row mounts. A routine that silently never
 * fires is the one failure an unattended producer cannot report afterwards:
 * nobody is watching at the firing instant, so a typo would surface only as
 * work that never happened. A spent one-shot is the deliberate exception — the
 * same config is re-read on every boot, so a passed `at` is recorded as
 * `not-armed` instead of taking the Host down with it.
 * @module @wowyuarm/dsh-agent-team/routine-schedule
 */

import type { AgentTeamMemberId } from './types.ts'
import { formatTeamTimestamp } from './time-format.ts'

/** Smallest recurring interval a routine accepts, in seconds. */
export const ROUTINE_MIN_INTERVAL_SECONDS = 60

/** Routine names address log lines and notice summaries, so keep them boring. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** RFC 3339 with an explicit offset or `Z`; a bare local time is refused. */
const ABSOLUTE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * One routine as it appears in the row's `config.routines` or in the store.
 *
 * Both triggers are declared here and exactly one must be present: `everySeconds`
 * repeats (aligned to `anchorAt` when given), `at` fires once at that instant.
 * `once: true` stops a repeating routine after its first delivery. `kind` picks
 * the action and therefore which of the two field sets is required; it is
 * omitted by every declaration written before `post` existed, where the only
 * action was a wake.
 */
export interface RoutineConfig {
  /** Stable name; addresses the log lines and the notice summary. */
  readonly name: string
  /** What a fire does: wake one Member (default), or post into one Channel. */
  readonly kind?: 'wake' | 'post'
  /** Wake target: a display handle (leading `@` optional) or a branded `member:<uuid>` id. */
  readonly member?: string
  /** The instruction injected into that Member's Session. */
  readonly prompt?: string
  /** One-line account shown on the notice; defaults to the routine name. */
  readonly summary?: string
  /** Post target's Workspace: a branded `workspace:<uuid>` id. */
  readonly workspaceId?: string
  /** Post target: a branded `channel:<uuid>` ref inside that Workspace. */
  readonly channel?: string
  /** Members to mention in the posted body; each is rendered as `@handle` and therefore woken. */
  readonly mentions?: readonly string[]
  /** The Message body, posted verbatim. */
  readonly body?: string
  /** Whether the posted Message opens a Task-backed Thread; a routine posts taskless unless told otherwise. */
  readonly asTask?: boolean
  /** Stop a repeating routine after its first delivery. */
  readonly once?: boolean
  /** Repeat interval in seconds; at least {@link ROUTINE_MIN_INTERVAL_SECONDS}. */
  readonly everySeconds?: number
  /** Single firing instant, RFC 3339 with an explicit offset or `Z`. */
  readonly at?: string
  /** Phase anchor for `everySeconds`; defaults to the first arming. */
  readonly anchorAt?: string
}

/** When a routine fires; the part of a routine the arithmetic reads. */
export interface RoutineSchedule {
  readonly once: boolean
  readonly everySeconds?: number
  readonly at?: number
  readonly anchorAt?: number
}

/** Wake one named Member with one instruction, in that Member's own Session. */
export interface WakeAction {
  readonly kind: 'wake'
  readonly member: string
  readonly prompt: string
  /** One-line account shown on the notice; defaults to the routine name. */
  readonly summary?: string
}

/** Post one Message into one named Channel, as the Human. */
export interface PostAction {
  readonly kind: 'post'
  /** The Workspace the Channel lives in: a branded `workspace:<uuid>` id. */
  readonly workspaceId: string
  /** The Channel to post into: a branded `channel:<uuid>` ref. */
  readonly channel: string
  /** Handles to mention, already trimmed and de-duplicated; may be empty. */
  readonly mentions: readonly string[]
  /** The Message body, posted verbatim. */
  readonly body: string
  readonly asTask: boolean
}

/** What one fire of a routine does. A routine declares exactly one action. */
export type RoutineAction = WakeAction | PostAction

/** One validated wake routine: exactly one trigger, instants already parsed. */
export interface WakeRoutine extends RoutineSchedule {
  readonly name: string
  readonly action: WakeAction
}

/** One validated post routine: exactly one trigger, instants already parsed. */
export interface PostRoutine extends RoutineSchedule {
  readonly name: string
  readonly action: PostAction
}

/** One validated routine: exactly one action and exactly one trigger. */
export type Routine = WakeRoutine | PostRoutine

/**
 * A routine name paired with one of its actions.
 *
 * Structural rather than {@link WakeRoutine} or {@link PostRoutine}, so a caller
 * that has already narrowed one routine's action has something to hand over:
 * none of the strings built from a routine reads its schedule.
 */
export interface RoutineFraming<TAction extends RoutineAction = RoutineAction> {
  readonly name: string
  readonly action: TAction
}

/** The target shape a wake request takes: a branded id, or a display handle. */
export interface RoutineTarget {
  readonly memberId?: AgentTeamMemberId
  readonly handle?: string
}

/**
 * Resolve one configured wake target. A branded `member:<uuid>` id addresses the
 * Member exactly; anything else is a handle, matched by the wake path
 * case-insensitively and with a leading `@` allowed.
 * @param member - the configured `member` value.
 * @returns the target fields a wake request carries.
 */
export function routineTarget(member: string): RoutineTarget {
  return member.startsWith('member:') ? { memberId: member as AgentTeamMemberId } : { handle: member }
}

/** One parsed absolute instant, or undefined when the text is not one. */
function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ABSOLUTE_TIME_PATTERN.test(value)) return undefined
  const instant = Date.parse(value)
  return Number.isNaN(instant) ? undefined : instant
}

/**
 * Validate one declaration list into the routine list the Host runs.
 *
 * Both callers — a profile's `config.routines` and the GUI's store — reach this
 * module as untrusted input, so every field is checked rather than assumed.
 * @param raw - the declarations, or undefined when there are none.
 * @param where - the source named in a rejection, so an operator can tell the
 * store from the profile.
 * @returns the frozen, validated routines in declaration order.
 * @throws Error naming the offending entry when the declaration cannot run.
 */
export function normalizeRoutines(raw: unknown, where = 'agent-team routines'): readonly Routine[] {
  if (raw === undefined || raw === null) return Object.freeze([])
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list`)
  const routines: Routine[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const at0 = `${where}[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at0} must be a mapping`)
    const { name, kind, once, everySeconds, at, anchorAt } = entry as RoutineConfig
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new Error(`${at0}.name must match ${NAME_PATTERN} (letters, digits, '-', '_')`)
    if (seen.has(name)) throw new Error(`${at0}.name '${name}' is declared twice`)
    seen.add(name)
    if (kind !== undefined && kind !== 'wake' && kind !== 'post') throw new Error(`${at0}.kind must be 'wake' or 'post'`)
    if (once !== undefined && typeof once !== 'boolean') throw new Error(`${at0}.once must be a boolean`)
    // The action is validated before the trigger: an entry that is unusable in
    // both ways is reported against its own fields, which is what the operator
    // edits, rather than against the schedule it has not written yet.
    const action = kind === 'post' ? postAction(entry as RoutineConfig, at0) : wakeAction(entry as RoutineConfig, at0)
    const hasInterval = everySeconds !== undefined
    const hasInstant = at !== undefined
    if (hasInterval === hasInstant) throw new Error(`${at0} needs exactly one trigger: everySeconds or at`)
    let interval: number | undefined
    let instant: number | undefined
    if (hasInterval) {
      if (typeof everySeconds !== 'number' || !Number.isInteger(everySeconds) || everySeconds < ROUTINE_MIN_INTERVAL_SECONDS) {
        throw new Error(`${at0}.everySeconds must be an integer >= ${ROUTINE_MIN_INTERVAL_SECONDS}`)
      }
      interval = everySeconds
    } else {
      instant = parseInstant(at)
      if (instant === undefined) throw new Error(`${at0}.at must be RFC 3339 with an explicit offset or 'Z'`)
    }
    let anchor: number | undefined
    if (anchorAt !== undefined) {
      anchor = parseInstant(anchorAt)
      if (anchor === undefined) throw new Error(`${at0}.anchorAt must be RFC 3339 with an explicit offset or 'Z'`)
    }
    const schedule = {
      once: once === true,
      ...(interval === undefined ? {} : { everySeconds: interval }),
      ...(instant === undefined ? {} : { at: instant }),
      ...(anchor === undefined ? {} : { anchorAt: anchor }),
    }
    routines.push(freezeRoutine(name, action, schedule))
  }
  return Object.freeze(routines)
}

/**
 * Freeze one validated routine and the action it carries.
 *
 * The branch on `action.kind` is what makes the result assignable to exactly one
 * member of {@link Routine}: a `WakeAction | PostAction` union is assignable to
 * neither side of it, so the two shapes are frozen where they are still known.
 * @param name - the validated routine name.
 * @param action - the validated action.
 * @param schedule - the validated trigger.
 * @returns the frozen routine.
 */
function freezeRoutine(name: string, action: RoutineAction, schedule: RoutineSchedule): Routine {
  return Object.freeze(action.kind === 'post'
    ? { name, action: Object.freeze(action), ...schedule }
    : { name, action: Object.freeze(action), ...schedule })
}

/** Validate the wake fields of one declaration; the default action when `kind` is absent. */
function wakeAction(entry: RoutineConfig, where: string): WakeAction {
  const { member, prompt, summary } = entry
  if (typeof member !== 'string' || member.trim().length === 0) throw new Error(`${where}.member must be a Member handle or id`)
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error(`${where}.prompt must be a non-empty instruction`)
  if (summary !== undefined && (typeof summary !== 'string' || summary.trim().length === 0)) throw new Error(`${where}.summary must be a non-empty string when present`)
  return { kind: 'wake', member: member.trim(), prompt: prompt.trim(), ...(summary === undefined ? {} : { summary: summary.trim() }) }
}

/**
 * Validate the post fields of one declaration.
 *
 * Both refs are carried as written and only checked for presence: what a branded
 * ref addresses is the ledger's to resolve, and resolving it here would mean a
 * second authority on ref syntax. A ref the Host cannot resolve is not silent —
 * it refuses the fire, and the producer records the reason.
 *
 * A mention is the only thing that makes a post reach anybody: a Channel member
 * who is not mentioned, and does not already follow the Thread, is not notified
 * and does not find the Message in their Inbox. So the handles are normalized
 * here with the same rule the delivery scan uses (a leading `@` is optional) and
 * written into the body verbatim.
 */
function postAction(entry: RoutineConfig, where: string): PostAction {
  const { workspaceId, channel, mentions, body, asTask } = entry
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) throw new Error(`${where}.workspaceId must name the Workspace the Channel lives in`)
  if (typeof channel !== 'string' || channel.trim().length === 0) throw new Error(`${where}.channel must name a Channel`)
  if (typeof body !== 'string' || body.trim().length === 0) throw new Error(`${where}.body must be a non-empty Message body`)
  if (asTask !== undefined && typeof asTask !== 'boolean') throw new Error(`${where}.asTask must be a boolean`)
  if (mentions !== undefined && !Array.isArray(mentions)) throw new Error(`${where}.mentions must be a list of Member handles`)
  const normalized: string[] = []
  for (const mention of mentions ?? []) {
    if (typeof mention !== 'string' || mention.trim().length === 0) throw new Error(`${where}.mentions must hold non-empty Member handles`)
    const handle = mention.trim().replace(/^@/, '')
    if (!normalized.includes(handle)) normalized.push(handle)
  }
  return { kind: 'post', workspaceId: workspaceId.trim(), channel: channel.trim(), mentions: Object.freeze(normalized), body: body.trim(), asTask: asTask === true }
}

/**
 * The body one post commits: the declared text with every configured mention
 * rendered as `@handle`.
 *
 * The mention is rendered here rather than trusted to the declared body so a
 * Mention that wakes somebody is always the same string the Member sees as a
 * chip; a body that already carries the handle is left alone.
 * @param routine - the post routine that fired.
 * @returns the Message body to commit.
 */
export function routinePostBody(routine: RoutineFraming<PostAction>): string {
  const missing = routine.action.mentions.filter(handle => !routine.action.body.includes(`@${handle}`))
  if (missing.length === 0) return routine.action.body
  return `${missing.map(handle => `@${handle}`).join(' ')} ${routine.action.body}`
}

/**
 * The next occurrence of one routine strictly after `fromMs`, or undefined when
 * it has no future occurrence (a spent one-shot).
 *
 * A repeating routine is aligned to its anchor — the configured `anchorAt`, or
 * the first time this Host armed it — so a restart re-derives the same phase
 * instead of drifting by however long the Host was down.
 * @param routine - the validated routine.
 * @param fromMs - the instant to search forward from.
 * @returns the next firing instant in epoch milliseconds, or undefined.
 */
export function nextRoutineOccurrence(routine: RoutineSchedule, fromMs: number): number | undefined {
  if (routine.everySeconds === undefined) return (routine.at ?? Number.NEGATIVE_INFINITY) > fromMs ? routine.at : undefined
  const anchor = routine.anchorAt ?? Math.floor(fromMs)
  const step = routine.everySeconds * 1000
  if (anchor > fromMs) return anchor
  const steps = Math.floor((fromMs - anchor) / step) + 1
  return anchor + steps * step
}

/** Whether a routine fires again after a delivery; a spent one-shot does not. */
export function isRepeatingRoutine(routine: RoutineSchedule): boolean {
  return routine.everySeconds !== undefined && routine.once !== true
}

/**
 * The instruction one wake fire injects.
 *
 * The framing states the two things the prompt alone cannot: this turn came
 * from a schedule rather than from the Human or a peer Member, and nobody is
 * waiting in this conversation for a reply. The instant is rendered in the
 * Team's own fixed coordination zone, the same rendering every other Team
 * timestamp uses.
 * @param wake - the routine name and wake action that fired.
 * @param firedAtMs - the firing instant in epoch milliseconds.
 * @returns the body of the injected notice.
 */
export function routineBody(wake: RoutineFraming<WakeAction>, firedAtMs: number): string {
  return [
    `[ROUTINE FIRE] ${wake.name} — fired ${formatTeamTimestamp(new Date(firedAtMs).toISOString())}`,
    'This is an unattended scheduled routine started by the Agent Team Host. No human and no other Member sent it, and nobody is waiting in this conversation for a reply.',
    '',
    wake.action.prompt,
  ].join('\n')
}

/**
 * The one-line account a wake fire carries on the injected notice.
 * @param wake - the routine name and wake action that fired.
 * @returns the declared summary, or a default naming the routine.
 */
export function routineSummary(wake: RoutineFraming<WakeAction>): string {
  return wake.action.summary ?? `Scheduled routine fired: ${wake.name}`
}
