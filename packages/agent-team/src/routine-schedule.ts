/**
 * Schedule arithmetic and the configuration contract of the Team's routine
 * producer (`./routines.ts`).
 *
 * A routine is one thing the Host does on a schedule: it wakes one named Member
 * by injecting an instruction into that Member's own Session. The Member then
 * decides what to do about it — the routine itself writes nothing to the Team
 * ledger, so the only trace a fire leaves is that Member's own turn and the
 * producer's fire log.
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
 * `once: true` stops a repeating routine after its first delivery.
 */
export interface RoutineConfig {
  /** Stable name; addresses the log lines and the notice summary. */
  readonly name: string
  /** Wake target: a display handle (leading `@` optional) or a branded `member:<uuid>` id. */
  readonly member?: string
  /** The instruction injected into that Member's Session. */
  readonly prompt?: string
  /** One-line account shown on the notice; defaults to the routine name. */
  readonly summary?: string
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

/**
 * One validated routine: exactly one trigger, instants already parsed, and the
 * one thing a fire does — wake one Member with one instruction.
 */
export interface Routine extends RoutineSchedule {
  readonly name: string
  /** The configured target, as written: a handle or a branded `member:<uuid>` id. */
  readonly member: string
  /** The instruction injected into that Member's Session. */
  readonly prompt: string
  /** One-line account shown on the notice; defaults to the routine name. */
  readonly summary?: string
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
    const { name, member, prompt, summary, once, everySeconds, at, anchorAt } = entry as RoutineConfig
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new Error(`${at0}.name must match ${NAME_PATTERN} (letters, digits, '-', '_')`)
    if (seen.has(name)) throw new Error(`${at0}.name '${name}' is declared twice`)
    seen.add(name)
    if (typeof member !== 'string' || member.trim().length === 0) throw new Error(`${at0}.member must be a Member handle or id`)
    if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error(`${at0}.prompt must be a non-empty instruction`)
    if (summary !== undefined && (typeof summary !== 'string' || summary.trim().length === 0)) throw new Error(`${at0}.summary must be a non-empty string when present`)
    if (once !== undefined && typeof once !== 'boolean') throw new Error(`${at0}.once must be a boolean`)
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
    routines.push(Object.freeze({
      name,
      member: member.trim(),
      prompt: prompt.trim(),
      ...(summary === undefined ? {} : { summary: summary.trim() }),
      once: once === true,
      ...(interval === undefined ? {} : { everySeconds: interval }),
      ...(instant === undefined ? {} : { at: instant }),
      ...(anchor === undefined ? {} : { anchorAt: anchor }),
    }))
  }
  return Object.freeze(routines)
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
 * The instruction one fire injects.
 *
 * The framing states the two things the prompt alone cannot: this turn came
 * from a schedule rather than from the Human or a peer Member, and nobody is
 * waiting in this conversation for a reply. The instant is rendered in the
 * Team's own fixed coordination zone, the same rendering every other Team
 * timestamp uses.
 * @param routine - the routine that fired.
 * @param firedAtMs - the firing instant in epoch milliseconds.
 * @returns the body of the injected notice.
 */
export function routineBody(routine: Pick<Routine, 'name' | 'prompt'>, firedAtMs: number): string {
  return [
    `[ROUTINE FIRE] ${routine.name} — fired ${formatTeamTimestamp(new Date(firedAtMs).toISOString())}`,
    'This is an unattended scheduled routine started by the Agent Team Host. No human and no other Member sent it, and nobody is waiting in this conversation for a reply.',
    '',
    routine.prompt,
  ].join('\n')
}

/**
 * The one-line account a wake fire carries on the injected notice.
 * @param routine - the routine that fired.
 * @returns the declared summary, or a default naming the routine.
 */
export function routineSummary(routine: Pick<Routine, 'name' | 'summary'>): string {
  return routine.summary ?? `Scheduled routine fired: ${routine.name}`
}
