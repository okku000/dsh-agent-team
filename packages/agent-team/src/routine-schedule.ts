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
 * what lets the schedule be tested at its boundaries — an expression that can
 * never fire, a fire across a daylight-saving step, a target written as an id or
 * as a handle — without a Host.
 *
 * The trigger is one five-field cron expression ({@link parseCronExpression}),
 * evaluated in the Host's own zone: `*&#47;15 * * * *` is every quarter hour of the
 * Host's clock rather than of UTC, because that is the clock an operator reads.
 * `once: true` turns any expression into a single fire — the first occurrence,
 * and no second one.
 *
 * Shape mistakes throw while the row mounts, an expression that never comes
 * round included. A routine that silently never fires is the one failure an
 * unattended producer cannot report afterwards: nobody is watching at the firing
 * instant, so a typo would surface only as work that never happened. A `once`
 * routine that already fired is the deliberate exception — its fire is remembered
 * in the log rather than in the config, so the same declaration is re-read on
 * every boot and simply left disarmed.
 * @module @wowyuarm/dsh-agent-team/routine-schedule
 */

import type { AgentTeamMemberId } from './types.ts'
import { cronTimeZone, nextCronOccurrence, parseCronExpression, type CronExpression } from './cron-expression.ts'
import { formatTeamTimestamp } from './time-format.ts'

/** Routine names address log lines and notice summaries, so keep them boring. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** The trigger fields this model used before it became cron-only. */
const LEGACY_TRIGGER_FIELDS = ['everySeconds', 'at', 'anchorAt'] as const

/** Where a routine's expression is read, when a caller wants it once. */
const EXPRESSIONS = new Map<string, CronExpression>()

/**
 * Parse one expression, reusing the parse of the same text.
 *
 * A routine is armed, previewed and validated repeatedly with the same string,
 * so the parse is cached by source text; parsing is pure, which is what makes
 * that safe to share across callers.
 * @param source - the expression as written.
 * @param where - the label a rejection starts with.
 * @returns the parsed expression.
 */
export function routineCron(source: string, where = 'cron'): CronExpression {
  const cached = EXPRESSIONS.get(source)
  if (cached !== undefined) return cached
  const expression = parseCronExpression(source, where)
  if (EXPRESSIONS.size > 256) EXPRESSIONS.clear()
  EXPRESSIONS.set(source, expression)
  return expression
}

/**
 * One routine as it appears in the row's `config.routines` or in the store.
 *
 * The trigger is one five-field cron expression, and `once: true` stops it
 * after its first delivery. There is deliberately no second way to say when a
 * routine fires: an interval and an absolute instant both describe a schedule
 * that a cron expression already describes, and two spellings of one schedule
 * are two things to keep in agreement.
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
  /** Stop the routine after its first delivery. */
  readonly once?: boolean
  /**
   * When it fires: five fields, `minute hour day-of-month month day-of-week`,
   * read on the Host's own clock. See `./cron-expression.ts` for the grammar.
   */
  readonly cron: string
}

/** When a routine fires; the part of a routine the arithmetic reads. */
export interface RoutineSchedule {
  readonly once: boolean
  readonly cron: string
}

/** The zone and instant a declaration's own validation evaluates in. */
export interface RoutineValidationOptions {
  /** IANA zone for the never-fires check; the Host's local zone by default. */
  readonly timeZone?: string
  /** The instant to look forward from; `Date.now()` by default. */
  readonly nowMs?: number
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

/**
 * Validate one declaration list into the routine list the Host runs.
 *
 * Both callers — a profile's `config.routines` and the GUI's store — reach this
 * module as untrusted input, so every field is checked rather than assumed.
 * @param raw - the declarations, or undefined when there are none.
 * @param where - the source named in a rejection, so an operator can tell the
 * store from the profile.
 * @param options - the zone and instant the never-fires check uses.
 * @returns the frozen, validated routines in declaration order.
 * @throws Error naming the offending entry when the declaration cannot run.
 */
export function normalizeRoutines(raw: unknown, where = 'agent-team routines', options: RoutineValidationOptions = {}): readonly Routine[] {
  if (raw === undefined || raw === null) return Object.freeze([])
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list`)
  const zone = cronTimeZone(options.timeZone)
  const nowMs = options.nowMs ?? Date.now()
  const routines: Routine[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const at0 = `${where}[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at0} must be a mapping`)
    // The interval and instant triggers this model used before are refused by
    // name rather than ignored: an entry that still carries one would otherwise
    // be read as having no trigger at all, and the reason would be a puzzle.
    for (const field of LEGACY_TRIGGER_FIELDS) {
      if ((entry as Record<string, unknown>)[field] !== undefined) {
        throw new Error(`${at0}.${field} is no longer supported: a routine's trigger is one five-field cron expression (cron: '*/15 * * * *', or '0 9 * * 1' with 'once: true' for a single fire)`)
      }
    }
    const { name, member, prompt, summary, once, cron } = entry as RoutineConfig
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new Error(`${at0}.name must match ${NAME_PATTERN} (letters, digits, '-', '_')`)
    if (seen.has(name)) throw new Error(`${at0}.name '${name}' is declared twice`)
    seen.add(name)
    if (typeof member !== 'string' || member.trim().length === 0) throw new Error(`${at0}.member must be a Member handle or id`)
    if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error(`${at0}.prompt must be a non-empty instruction`)
    if (summary !== undefined && (typeof summary !== 'string' || summary.trim().length === 0)) throw new Error(`${at0}.summary must be a non-empty string when present`)
    if (once !== undefined && typeof once !== 'boolean') throw new Error(`${at0}.once must be a boolean`)
    const expression = routineCron(cron as string, `${at0}.cron`)
    if (nextCronOccurrence(expression, nowMs, zone) === undefined) {
      throw new Error(`${at0}.cron '${expression.source}' never fires within five years in zone '${zone}'; check its day-of-month, month and day-of-week fields`)
    }
    routines.push(Object.freeze({
      name,
      member: member.trim(),
      prompt: prompt.trim(),
      ...(summary === undefined ? {} : { summary: summary.trim() }),
      once: once === true,
      cron: expression.source,
    }))
  }
  return Object.freeze(routines)
}

/**
 * The next occurrence of one routine strictly after `fromMs`, or undefined when
 * it has no future occurrence (a spent one-shot).
 *
 * An expression is a fixed point on the wall clock, so a restart lands on the
 * same phase it would have had if the Host had never gone down: there is no
 * anchor to keep, and downtime cannot drift a routine's own schedule.
 * @param routine - the validated routine.
 * @param fromMs - the instant to search forward from.
 * @param timeZone - an IANA zone; defaults to the Host's local zone.
 * @returns the next firing instant in epoch milliseconds, or undefined.
 */
export function nextRoutineOccurrence(routine: RoutineSchedule, fromMs: number, timeZone?: string): number | undefined {
  return nextCronOccurrence(routineCron(routine.cron), fromMs, timeZone)
}

/** Whether a routine fires again after a delivery; a spent one-shot does not. */
export function isRepeatingRoutine(routine: RoutineSchedule): boolean {
  return routine.once !== true
}

/**
 * The instruction one fire injects.
 *
 * The framing states the three things the prompt alone cannot: this turn came
 * from a schedule rather than from the Human or a peer Member, which schedule it
 * was, and that nobody is waiting in this conversation for a reply. The instant
 * is rendered in the Team's own fixed coordination zone, the same rendering
 * every other Team timestamp uses; the expression is the one the operator wrote,
 * not a rendering of it.
 * @param routine - the routine that fired.
 * @param firedAtMs - the firing instant in epoch milliseconds.
 * @returns the body of the injected notice.
 */
export function routineBody(routine: Pick<Routine, 'name' | 'prompt' | 'cron'>, firedAtMs: number): string {
  return [
    `[ROUTINE FIRE] ${routine.name} — fired ${formatTeamTimestamp(new Date(firedAtMs).toISOString())} (cron '${routine.cron}')`,
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
