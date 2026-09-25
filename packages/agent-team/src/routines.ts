/**
 * The Team's built-in routine producer: a schedule whose entries wake one named
 * Member.
 *
 * The Host side of a wake lives in `member-wake.ts` — one producer-triggered
 * turn in a Member's own Session. This module is the producer the Team ships
 * itself: a row whose `config.routines` says when to fire and whom to wake, so a
 * schedule needs no second plugin, no extra dependency, and no path wiring
 * beyond the row this bundle already inserts. A third-party producer (a watcher,
 * another Host plugin) still calls `wakeMember` exactly as this one does.
 *
 * A wake is context, never authority: it injects an instruction into a Member's
 * own Session and commits nothing, so no other Member can cite it. Whatever the
 * woken Member then decides to say or do is that Member's own Team work, made
 * with its own identity and its own judgement.
 *
 * Two things are deliberately the producer's, not the Host's:
 *
 * - The fire log. A routine fires unattended, at a moment nobody is watching,
 *   and the ways a fire can fail are different operational answers — a typo in
 *   the schedule, a suspended Member, a Member this Host has not activated, a
 *   broken Session. The Host reports the reason; only the producer can keep it,
 *   so every fire is appended to
 *   `$DSH_HOME/agent-team/routines/fires.jsonl` and stays readable long after
 *   the console line is gone.
 * - The framing. A woken Member cannot infer from the instruction alone that
 *   this turn came from a schedule rather than from the Human or a peer, and
 *   that nobody is waiting for an answer.
 * - The spent one-shot. `once: true` means "at the next occurrence, and then
 *   never again", and a cron expression has no year field, so the producer — not
 *   the expression — has to remember that the fire already happened. It reads
 *   that answer back out of the fire log at every mount, which is also why a
 *   `once` delivery is kept in the log even after the ordinary lines are
 *   trimmed: the marker is the only thing standing between one fire and one
 *   fire per restart.
 *
 * The schedule itself (`routine-schedule.ts`) is pure; this row owns the
 * timers, the log, and the calls into the Host.
 * @module @wowyuarm/dsh-agent-team/routines
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { AgentTeamWakeDeliveryError, type AgentTeamWakeMode, type AgentTeamWakeResult } from './member-wake.ts'
import { mergeRoutines, readRoutineStore, routineStorePath, watchRoutineStore } from './routine-store.ts'
import {
  isRepeatingRoutine, nextRoutineOccurrence, routineBody, routineSummary, routineTarget,
  type Routine, type RoutineConfig,
} from './routine-schedule.ts'

/** Cordis row name; also the source kind every fire carries into the Member's log. */
export const name = 'wowyuarm-agent-team-routines'

/** The Host owns Member Sessions; without that service there is nobody to wake. */
export const inject = ['agentTeam']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** This producer's own attribution; the wake passes it through as the notice's source kind. */
    'wowyuarm-agent-team-routines': { kind: 'wowyuarm-agent-team-routines' } & ContextFormed
  }
}

/**
 * Row configuration.
 *
 * An absent or empty list arms nothing and logs one line: the row is part of
 * every install, while what a Host schedules is the operator's, so a Team with
 * no routines is the normal state rather than a misconfiguration.
 */
export interface Config {
  /** The routines this Host runs, in declaration order. */
  readonly routines?: readonly RoutineConfig[]
}

/** Path segments of the fire log under the Harness home. */
const FIRE_LOG_SEGMENTS = ['agent-team', 'routines', 'fires.jsonl'] as const

/** A fire log larger than this is trimmed to the newest {@link FIRE_LOG_KEEP_LINES} lines. */
const FIRE_LOG_MAX_BYTES = 256 * 1024

/** Lines kept when the fire log is trimmed. */
const FIRE_LOG_KEEP_LINES = 200

/** Absolute path of the durable fire log. */
export function routineFireLogPath(): string {
  return dshHomePath(...FIRE_LOG_SEGMENTS)
}

/** One delivered fire, as recorded. */
export interface RoutineDeliveredRecord {
  readonly routine: string
  readonly member: string
  readonly outcome: 'delivered'
  /**
   * Whether the routine declared itself a one-shot. A delivered one-shot is the
   * record that stops it firing again after a restart, so this line outlives the
   * log's ordinary trim.
   */
  readonly once: boolean
  /** The lane the wake took: `followup` for an idle Member, `steer` for a busy one. */
  readonly mode: AgentTeamWakeMode
  readonly sessionId: string
  readonly firedAt: string
  readonly recordedAt: string
}

/** One refused fire, as recorded: the reason is the operator's answer, the detail the message. */
export interface RoutineFailedRecord {
  readonly routine: string
  /** The Member the wake named. */
  readonly member?: string
  readonly outcome: 'failed'
  readonly reason: string
  readonly detail: string
  readonly firedAt: string
  readonly recordedAt: string
}

/**
 * One routine that had no occurrence to arm.
 *
 * Validation refuses an expression that cannot fire, so this lane is a guard
 * rather than an expected state: it is reached when the horizon the search
 * looked through holds no occurrence, which a declaration that validated
 * moments earlier can only mean after a clock so far off the calendar moved.
 */
export interface RoutineNotArmedRecord {
  readonly routine: string
  /** The Member the wake names. */
  readonly member?: string
  readonly outcome: 'not-armed'
  readonly detail: string
  readonly recordedAt: string
}

/** One fire-log line. */
export type RoutineFireRecord = RoutineDeliveredRecord | RoutineFailedRecord | RoutineNotArmedRecord

/** Whether one raw log line records a delivered one-shot, the marker a restart reads. */
function isSpentOneShotLine(line: string): boolean {
  try {
    const record = JSON.parse(line) as Partial<RoutineDeliveredRecord>
    return record.outcome === 'delivered' && record.once === true
  } catch {
    return false
  }
}

/**
 * Append-only fire log with a size cap.
 *
 * The log is best-effort by construction: a routine whose record cannot be
 * written still fired, and losing the record must not become a second failure,
 * so an unwritable path warns and returns. Trimming keeps the newest lines,
 * because the interesting fire is the last one — and it keeps every delivered
 * one-shot line besides, because that line is what stops a `once` routine from
 * firing again at the next mount.
 * @param path - absolute log path.
 * @param warn - sink for the one warning an unwritable log produces.
 * @returns the recorder, which never throws.
 */
export function createRoutineFireLog(path: string, warn: (message: string) => void): (record: RoutineFireRecord) => void {
  return record => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(record)}\n`)
      if (statSync(path).size > FIRE_LOG_MAX_BYTES) {
        const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0)
        const kept = lines.filter((line, index) => isSpentOneShotLine(line) || index >= lines.length - FIRE_LOG_KEEP_LINES)
        writeFileSync(path, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
      }
    } catch (error) {
      warn(`agent-team routines: fire log is unwritable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

/**
 * Every record in the fire log, oldest first.
 *
 * A line that cannot be read is skipped rather than fatal: the log is a
 * convenience an operator may have edited, and the one thing the producer must
 * never do is refuse to boot because a record is malformed.
 * @param path - absolute log path.
 * @returns the parsed records; empty when there is no log yet.
 */
export function readRoutineFireLog(path: string): readonly RoutineFireRecord[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const records: RoutineFireRecord[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const record = JSON.parse(line) as RoutineFireRecord
      if (typeof record.routine === 'string' && typeof record.outcome === 'string') records.push(record)
    } catch {
      continue
    }
  }
  return records
}

/** The names of the one-shot routines that already had their fire. */
export function spentOneShotRoutines(records: readonly RoutineFireRecord[]): ReadonlySet<string> {
  const spent = new Set<string>()
  for (const record of records) {
    if (record.outcome === 'delivered' && record.once === true) spent.add(record.routine)
  }
  return spent
}

/** How one routine's target reads on a log line. */
function routineTargetLabel(routine: Routine): string {
  return `member '${routine.member}'`
}

/** The Member field one fire record carries, frozen with the record. */
function routineTargetFields(routine: Routine): { readonly member: string } {
  return { member: routine.member }
}

/** What the scheduler reports as it arms and fires; the row logs and records it. */
export type RoutineEvent =
  | { readonly outcome: 'armed'; readonly routine: Routine; readonly next: number }
  | { readonly outcome: 'not-armed'; readonly routine: Routine; readonly detail: string }
  | { readonly outcome: 'delivered'; readonly routine: Routine; readonly firedAt: number; readonly result: AgentTeamWakeResult }
  | { readonly outcome: 'failed'; readonly routine: Routine; readonly firedAt: number; readonly reason: string; readonly detail: string }

export interface RoutineSchedulerOptions {
  /** The validated routines to run. */
  readonly routines: readonly Routine[]
  /**
   * Deliver one fire. A refused wake arrives as an `AgentTeamWakeDeliveryError`.
   * The Host's `wakeMember` answers synchronously; the promise arm keeps a
   * producer that has something of its own to await working unchanged.
   */
  readonly deliver: (routine: Routine, firedAtMs: number) => AgentTeamWakeResult | Promise<AgentTeamWakeResult>
  /** One observer for every arming, delivery and refusal. */
  readonly onEvent: (event: RoutineEvent) => void
}

/**
 * The routine timers.
 *
 * One timer per routine, always armed for the routine's next occurrence. A
 * repeat re-arms from the moment its delivery settled, which a cron expression
 * makes free: the phase belongs to the expression rather than to the arming, so
 * a slow wake cannot drift it — and the occurrences the wake outlived are
 * skipped instead of arriving as a catch-up burst. A spent one-shot disarms.
 * `fire` never rejects — a refusal is an event, not an exception the timer
 * could not handle.
 */
export class RoutineScheduler {
  private readonly routines: readonly Routine[]
  private readonly deliver: RoutineSchedulerOptions['deliver']
  private readonly onEvent: RoutineSchedulerOptions['onEvent']
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly targets = new Map<string, number>()

  constructor(options: RoutineSchedulerOptions) {
    this.routines = options.routines
    this.deliver = options.deliver
    this.onEvent = options.onEvent
  }

  /** Arm every routine; called once when the row mounts. */
  armAll(): void {
    for (const routine of this.routines) this.arm(routine)
  }

  /** The instant one routine is armed for, or undefined when it is not armed. */
  nextArmed(routineName: string): number | undefined {
    return this.targets.get(routineName)
  }

  /** Clear every armed timer; called when the row unmounts. */
  dispose(): void {
    // Snapshot the names first: `disarm` mutates the map this loop reads.
    for (const routineName of Array.from(this.timers.keys())) this.disarm(routineName)
  }

  /**
   * Fire one routine now, through the same path its timer uses.
   * @param routine - the routine to deliver.
   */
  async fire(routine: Routine): Promise<void> {
    this.disarm(routine.name)
    const firedAt = Date.now()
    try {
      const result = await this.deliver(routine, firedAt)
      this.onEvent({ outcome: 'delivered', routine, firedAt, result })
    } catch (error) {
      this.onEvent({
        outcome: 'failed',
        routine,
        firedAt,
        reason: error instanceof AgentTeamWakeDeliveryError ? error.reason : 'wake-failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    // From the settled instant: the expression owns the phase, so this lands on
    // the same grid it would have without the delay, and a delivery that
    // outlived several occurrences costs one fire rather than a burst.
    if (isRepeatingRoutine(routine)) this.arm(routine)
  }

  private disarm(routineName: string): void {
    const timer = this.timers.get(routineName)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(routineName)
    this.targets.delete(routineName)
  }

  /** Arm one routine for the next occurrence after `fromMs` (default: now). */
  private arm(routine: Routine, fromMs: number = Date.now()): void {
    const next = nextRoutineOccurrence(routine, fromMs)
    if (next === undefined) {
      this.onEvent({ outcome: 'not-armed', routine, detail: 'no future occurrence' })
      return
    }
    const timer = setTimeout(() => { void this.fire(routine) }, Math.max(0, next - Date.now()))
    // A pending routine must not be what keeps the Host process alive — a
    // one-shot command would otherwise hang until the instant arrived. The
    // guard keeps a timer double (tests, a non-Node timer) working unchanged.
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.set(routine.name, timer)
    this.targets.set(routine.name, next)
    this.onEvent({ outcome: 'armed', routine, next })
  }
}

/**
 * Mount the routine row: validate the schedule, then arm it.
 *
 * Two sources feed one schedule. The row's `config.routines` is the operator's
 * declaration and is read exactly once — a profile edit reaches a running Host
 * as a row reload, as it always did. The store beside the fire log is the live
 * set an operator edits from the GUI, so it is re-read whenever it changes and
 * the whole schedule is armed again from the merged list: a routine added,
 * edited, or removed in the GUI takes effect without restarting the Host.
 * @param ctx - Cordis context carrying the Team Host service.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const warn = (message: string): void => ctx.logger.warn(message)
  const storePath = routineStorePath()
  // Read before the effect: a declaration the Host cannot run has to fail the
  // row loudly at mount, exactly as it did before the store existed.
  const declared = mergeRoutines(readRoutineStore(storePath, warn), config?.routines)
  const fireLogPath = routineFireLogPath()
  const appendFire = createRoutineFireLog(fireLogPath, warn)
  const recordedAt = (): string => new Date().toISOString()
  let scheduler: RoutineScheduler | undefined

  /**
   * The routines this mount may arm: every one except a one-shot that already
   * had its fire. The log is re-read here rather than cached, so a delete and a
   * fresh save in the GUI is picked up by the same store watcher that re-arms
   * everything else.
   */
  const armable = (routines: readonly Routine[]): readonly Routine[] => {
    const spent = spentOneShotRoutines(readRoutineFireLog(fireLogPath))
    return routines.filter(routine => {
      if (!(routine.once && spent.has(routine.name))) return true
      ctx.logger.info(`agent-team routines: '${routine.name}' already fired once; not armed`)
      return false
    })
  }

  const buildScheduler = (routines: readonly Routine[]): RoutineScheduler => new RoutineScheduler({
    routines,
    deliver: (routine, firedAt) => ctx.agentTeam.wakeMember({
      ...routineTarget(routine.member),
      routine: routine.name,
      plugin: name,
      summary: routineSummary(routine),
      body: routineBody(routine, firedAt),
    }),
    onEvent: event => {
      const { routine } = event
      if (event.outcome === 'armed') {
        ctx.logger.info(`agent-team routines: '${routine.name}' armed for ${new Date(event.next).toISOString()} (${routineTargetLabel(routine)})`)
        return
      }
      if (event.outcome === 'not-armed') {
        // Reached only when the search horizon holds no occurrence at all, which
        // validation already refuses. Boot must survive it, but silence would
        // look like a routine that never fires.
        ctx.logger.warn(`agent-team routines: '${routine.name}' has no future occurrence; not armed`)
        appendFire({ routine: routine.name, ...routineTargetFields(routine), outcome: 'not-armed', detail: event.detail, recordedAt: recordedAt() })
        return
      }
      if (event.outcome === 'delivered') {
        ctx.logger.info(`agent-team routines: '${routine.name}' delivered to '${event.result.memberHandle}' via ${event.result.mode}`)
        appendFire({
          routine: routine.name,
          member: event.result.memberHandle,
          outcome: 'delivered',
          once: routine.once,
          mode: event.result.mode,
          sessionId: event.result.sessionId,
          firedAt: new Date(event.firedAt).toISOString(),
          recordedAt: recordedAt(),
        })
        return
      }
      ctx.logger.warn(`agent-team routines: '${routine.name}' not delivered (${event.reason}): ${event.detail}`)
      appendFire({
        routine: routine.name,
        ...routineTargetFields(routine),
        outcome: 'failed',
        reason: event.reason,
        detail: event.detail,
        firedAt: new Date(event.firedAt).toISOString(),
        recordedAt: recordedAt(),
      })
    },
  })

  /** Arm the current merged list, replacing whatever the previous one armed. */
  const rearm = (): void => {
    scheduler?.dispose()
    scheduler = undefined
    let routines: readonly Routine[]
    try {
      routines = mergeRoutines(readRoutineStore(storePath, warn), config?.routines)
    } catch (error) {
      // The operator's own declaration cannot change without a row reload, so a
      // throw here is unreachable from a GUI edit; guarding anyway keeps a live
      // Host from dying inside a watcher callback.
      warn(`agent-team routines: the schedule could not be reloaded (${error instanceof Error ? error.message : String(error)}); the previous schedule stays armed`)
      return
    }
    if (routines.length === 0) {
      ctx.logger.info('agent-team routines: no routines configured')
      return
    }
    const due = armable(routines)
    if (due.length === 0) return
    scheduler = buildScheduler(due)
    scheduler.armAll()
  }

  ctx.effect(() => {
    // Publish the operator's own declarations after they validated above: the
    // routine API reports them as declared on this row rather than saved into
    // the store, and refuses to save over a name they own. Arming stays here.
    const withdrawDeclarations = ctx.agentTeam.declareRoutines(name, config?.routines ?? [])
    const unsubscribe = watchRoutineStore(storePath, () => { rearm() }, warn)
    if (declared.length === 0) {
      ctx.logger.info('agent-team routines: no routines configured')
    } else {
      const due = armable(declared)
      if (due.length > 0) {
        scheduler = buildScheduler(due)
        scheduler.armAll()
      }
    }
    return () => {
      withdrawDeclarations()
      unsubscribe()
      scheduler?.dispose()
      scheduler = undefined
    }
  }, 'agent-team.routines.timers')
}
