/**
 * The Team's built-in routine producer: a schedule that wakes one named Member.
 *
 * The Host side of a wake lives in `member-wake.ts` — one producer-triggered
 * turn in a Member's own Session. This module is the producer the Team ships
 * itself: a row whose `config.routines` says when to fire and whom to wake, so
 * a schedule needs no second plugin, no extra dependency, and no path wiring
 * beyond the row this bundle already inserts. A third-party producer (a
 * watcher, another Host plugin) still calls `wakeMember` exactly as this one
 * does.
 *
 * Two things are deliberately the producer's, not the Host's:
 *
 * - The fire log. A routine fires unattended, at a moment nobody is watching,
 *   and the four ways a wake can fail are four different operational answers —
 *   a typo in the schedule, a suspended Member, a Member this Host has not
 *   activated, a broken Session. The Host reports the reason; only the producer
 *   can keep it, so every fire is appended to
 *   `$DSH_HOME/agent-team/routines/fires.jsonl` and stays readable long after
 *   the console line is gone.
 * - The framing. A woken Member cannot infer from the instruction alone that
 *   this turn came from a schedule rather than from the Human or a peer, and
 *   that nobody is waiting for an answer.
 *
 * The schedule itself (`routine-schedule.ts`) is pure; this row owns the
 * timers, the log, and the call into the Host. Nothing here is a Team fact:
 * a fired instruction is context the Member reads, never ledger authority.
 * @module @wowyuarm/dsh-agent-team/routines
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { AgentTeamWakeDeliveryError, type AgentTeamWakeMode, type AgentTeamWakeResult } from './member-wake.ts'
import { isRepeatingRoutine, nextRoutineOccurrence, normalizeRoutines, routineBody, routineSummary, routineTarget, type Routine, type RoutineConfig } from './routine-schedule.ts'

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
  /** The lane the wake took: `followup` for an idle Member, `steer` for a busy one. */
  readonly mode: AgentTeamWakeMode
  readonly sessionId: string
  readonly firedAt: string
  readonly recordedAt: string
}

/** One refused fire, as recorded: the reason is the operator's answer, the detail the message. */
export interface RoutineFailedRecord {
  readonly routine: string
  readonly member: string
  readonly outcome: 'failed'
  readonly reason: string
  readonly detail: string
  readonly firedAt: string
  readonly recordedAt: string
}

/** One routine that had no future occurrence to arm. */
export interface RoutineNotArmedRecord {
  readonly routine: string
  readonly member: string
  readonly outcome: 'not-armed'
  readonly detail: string
  readonly recordedAt: string
}

/** One fire-log line. */
export type RoutineFireRecord = RoutineDeliveredRecord | RoutineFailedRecord | RoutineNotArmedRecord

/**
 * Append-only fire log with a size cap.
 *
 * The log is best-effort by construction: a routine whose record cannot be
 * written still fired, and losing the record must not become a second failure,
 * so an unwritable path warns and returns. Trimming keeps the newest lines,
 * because the interesting fire is the last one.
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
        const kept = readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).slice(-FIRE_LOG_KEEP_LINES)
        writeFileSync(path, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
      }
    } catch (error) {
      warn(`agent-team routines: fire log is unwritable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
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
  /** Deliver one fire; the Host's refusal arrives as an `AgentTeamWakeDeliveryError`. */
  readonly wake: (routine: Routine, firedAtMs: number) => Promise<AgentTeamWakeResult>
  /** One observer for every arming, delivery and refusal. */
  readonly onEvent: (event: RoutineEvent) => void
}

/**
 * The routine timers.
 *
 * One timer per routine, always armed for the routine's next occurrence. A
 * repeat re-arms from the instant it was due rather than from the moment it
 * settled, so a slow wake does not push the phase; a spent one-shot disarms.
 * `fire` never rejects — a refusal is an event, not an exception the timer
 * could not handle.
 */
export class RoutineScheduler {
  private readonly routines: readonly Routine[]
  private readonly wake: RoutineSchedulerOptions['wake']
  private readonly onEvent: RoutineSchedulerOptions['onEvent']
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly targets = new Map<string, number>()

  constructor(options: RoutineSchedulerOptions) {
    this.routines = options.routines
    this.wake = options.wake
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
    // The instant this fire was armed for, not the instant it settled: a repeat
    // re-arms from its due instant, so a wake that takes minutes cannot push the
    // phase of a routine that carries no explicit anchor.
    const due = this.targets.get(routine.name)
    this.disarm(routine.name)
    const firedAt = Date.now()
    try {
      const result = await this.wake(routine, firedAt)
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
    if (isRepeatingRoutine(routine)) this.arm(routine, due ?? firedAt)
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
 * The schedule is read once, at mount. A profile edit therefore reaches a
 * running Host as a row reload — dispose, re-validate, re-arm — which is the
 * behaviour a changed instant wants anyway.
 * @param ctx - Cordis context carrying the Team Host service.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const routines = normalizeRoutines(config?.routines)
  if (routines.length === 0) {
    ctx.logger.info('agent-team routines: no routines configured')
    return
  }
  const appendFire = createRoutineFireLog(routineFireLogPath(), message => ctx.logger.warn(message))
  const recordedAt = (): string => new Date().toISOString()

  const scheduler = new RoutineScheduler({
    routines,
    wake: (routine, firedAt) => ctx.agentTeam.wakeMember({
      ...routineTarget(routine.member),
      routine: routine.name,
      plugin: name,
      summary: routineSummary(routine),
      body: routineBody(routine, firedAt),
    }),
    onEvent: event => {
      const { routine } = event
      if (event.outcome === 'armed') {
        ctx.logger.info(`agent-team routines: '${routine.name}' armed for ${new Date(event.next).toISOString()} (member '${routine.member}')`)
        return
      }
      if (event.outcome === 'not-armed') {
        // A one-shot whose instant passed while the Host was down. Boot must
        // survive it, but silence would look like a routine that never fires.
        ctx.logger.warn(`agent-team routines: '${routine.name}' has no future occurrence; not armed`)
        appendFire({ routine: routine.name, member: routine.member, outcome: 'not-armed', detail: event.detail, recordedAt: recordedAt() })
        return
      }
      if (event.outcome === 'delivered') {
        ctx.logger.info(`agent-team routines: '${routine.name}' delivered to '${event.result.memberHandle}' via ${event.result.mode}`)
        appendFire({
          routine: routine.name,
          member: event.result.memberHandle,
          outcome: 'delivered',
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
        member: routine.member,
        outcome: 'failed',
        reason: event.reason,
        detail: event.detail,
        firedAt: new Date(event.firedAt).toISOString(),
        recordedAt: recordedAt(),
      })
    },
  })

  ctx.effect(() => {
    scheduler.armAll()
    return () => scheduler.dispose()
  }, 'agent-team.routines.timers')
}
