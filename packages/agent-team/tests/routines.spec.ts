import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTeamWakeDeliveryError, type AgentTeamWakeMode, type AgentTeamWakeRequest, type AgentTeamWakeResult } from '../src/member-wake.ts'
import { routineStorePath, writeRoutineStore } from '../src/routine-store.ts'
import type { Routine, RoutineConfig } from '../src/routine-schedule.ts'
import * as routines from '../src/routines.ts'
import type { RoutineFireRecord } from '../src/routines.ts'
import type { AgentTeamMemberId } from '../src/types.ts'

/**
 * The built-in routine producer: the schedule's timers, the fire log, and the
 * row that wires them to the Host's wake. The arithmetic itself is covered by
 * `routine-schedule.spec.ts`; what matters here is what an unattended fire
 * leaves behind — the armed instant, the phase after a slow delivery, the
 * record of a refusal, and a log that cannot break the Host.
 */

const T = Date.parse('2026-09-25T00:00:00.000Z')
const MEMBER_ID = 'member:tes' as AgentTeamMemberId

/**
 * A validated repeating routine, so the timers can be driven without the config
 * layer. The grid is every minute — the one phase every zone shares, because
 * every real offset is a whole number of minutes — so these tests are about the
 * timers rather than about the arithmetic `cron-expression.spec.ts` owns.
 */
function repeating(name: string, cron = '* * * * *', overrides: Partial<Routine> = {}): Routine {
  return { name, member: 'tes', prompt: 'check the model catalog', once: false, cron, ...overrides }
}

/** A validated one-shot routine: the next occurrence, and then no more. */
function oneShot(name: string, overrides: Partial<Routine> = {}): Routine {
  return { name, member: 'tes', prompt: 'check the model catalog', once: true, cron: '* * * * *', ...overrides }
}

function wakeResult(routineName: string, mode: AgentTeamWakeMode = 'followup'): AgentTeamWakeResult {
  return {
    delivered: true,
    mode,
    memberId: MEMBER_ID,
    memberHandle: 'tes',
    sessionId: SessionId('session:tes'),
    routine: routineName,
    summary: 'check',
  }
}

interface Fired {
  readonly routine: Routine
  readonly firedAt: number
}

/**
 * One scheduler with its events and wake deliveries recorded, so a test states
 * only what it drives.
 */
function schedulerOf(
  routinesToRun: readonly Routine[],
  wake: (routine: Routine, firedAt: number) => Promise<AgentTeamWakeResult>,
) {
  const events: routines.RoutineEvent[] = []
  const calls: Fired[] = []
  const scheduler = new routines.RoutineScheduler({
    routines: routinesToRun,
    deliver: async (routine, firedAt) => {
      calls.push({ routine, firedAt })
      return wake(routine, firedAt)
    },
    onEvent: event => { events.push(event) },
  })
  return { scheduler, events, calls }
}

describe('RoutineScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms one timer per routine for its next occurrence, and stays quiet until then', async () => {
    const frequent = repeating('frequent')
    const slower = repeating('slower', '*/5 * * * *')
    const { scheduler, events, calls } = schedulerOf([frequent, slower], async routine => wakeResult(routine.name))

    scheduler.armAll()

    expect(events).toEqual([
      { outcome: 'armed', routine: frequent, next: T + 60_000 },
      { outcome: 'armed', routine: slower, next: T + 300_000 },
    ])
    expect(scheduler.nextArmed('frequent')).toBe(T + 60_000)
    expect(scheduler.nextArmed('slower')).toBe(T + 300_000)

    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toEqual([])
  })

  it('arms a one-shot for its next occurrence rather than a past instant', async () => {
    // `once` is a promise about the future, not a stored instant: the expression
    // always names its next occurrence, so there is nothing here to be spent.
    const single = oneShot('single', { cron: '*/5 * * * *' })
    const { scheduler, events, calls } = schedulerOf([single], async routine => wakeResult(routine.name))

    scheduler.armAll()

    expect(events).toEqual([{ outcome: 'armed', routine: single, next: T + 300_000 }])
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls).toEqual([{ routine: single, firedAt: T + 300_000 }])
  })

  it('delivers at the armed instant and re-arms the repeat on its grid', async () => {
    const frequent = repeating('frequent')
    const { scheduler, events, calls } = schedulerOf([frequent], async routine => wakeResult(routine.name, 'steer'))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls).toEqual([{ routine: frequent, firedAt: T + 60_000 }])
    expect(events).toEqual([
      { outcome: 'armed', routine: frequent, next: T + 60_000 },
      { outcome: 'delivered', routine: frequent, firedAt: T + 60_000, result: wakeResult('frequent', 'steer') },
      { outcome: 'armed', routine: frequent, next: T + 120_000 },
    ])
    // The next instant is the grid's, one occurrence after the one that fired.
    expect(scheduler.nextArmed('frequent')).toBe(T + 120_000)
  })

  it('skips the occurrences a slow delivery outlived instead of firing them as a burst', async () => {
    let settle: ((result: AgentTeamWakeResult) => void) | undefined
    const frequent = repeating('frequent')
    const { scheduler, calls } = schedulerOf([frequent], () => new Promise(resolve => { settle = resolve }))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    // In flight: the routine holds no timer, so nothing can fire over the wake.
    expect(scheduler.nextArmed('frequent')).toBeUndefined()

    // Two minutes of delivery time, then a settled wake. The occurrences those
    // two minutes carried are gone: one fire is one delivery, not a backlog.
    await vi.advanceTimersByTimeAsync(120_000)
    settle?.(wakeResult('frequent'))
    await vi.advanceTimersByTimeAsync(0)

    // The next instant is the next occurrence after the wake settled, so the
    // expression's phase is intact and the two minutes it outlived are simply
    // missed — nobody is waiting for a backlog of unattended fires.
    expect(scheduler.nextArmed('frequent')).toBe(T + 240_000)
    expect(calls).toHaveLength(1)
  })

  it('records a refused wake as failed with its reason, and still re-arms the repeat', async () => {
    const everyMinute = repeating('every-minute')
    const { scheduler, events } = schedulerOf([everyMinute], async () => {
      throw new AgentTeamWakeDeliveryError('no-live-session', undefined, 'tes', "Agent Member 'tes' has no live session")
    })

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(60_000)

    // Armed at mount, refused at the instant, re-armed after the refusal.
    expect(events.map(event => event.outcome)).toEqual(['armed', 'failed', 'armed'])
    expect(events[1]).toMatchObject({
      outcome: 'failed',
      routine: everyMinute,
      firedAt: T + 60_000,
      reason: 'no-live-session',
      detail: "Agent Member 'tes' has no live session",
    })
    expect(scheduler.nextArmed('every-minute')).toBe(T + 120_000)
  })

  it('never rejects on an unexpected failure: an unknown error is a failed event too', async () => {
    const frequent = repeating('frequent')
    const { scheduler, events } = schedulerOf([frequent], async () => { throw new Error('the Host is on fire') })

    await expect(scheduler.fire(frequent)).resolves.toBeUndefined()
    // Fired directly (no arming first), so the failure precedes the re-arm.
    expect(events.map(event => event.outcome)).toEqual(['failed', 'armed'])
    expect(events[0]).toEqual({ outcome: 'failed', routine: frequent, firedAt: T, reason: 'wake-failed', detail: 'the Host is on fire' })
    expect(scheduler.nextArmed('frequent')).toBe(T + 60_000)
  })

  it('disarms a routine declared once after its first delivery', async () => {
    const once = oneShot('once-only')
    const { scheduler, calls } = schedulerOf([once], async routine => wakeResult(routine.name))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls).toHaveLength(1)
    expect(scheduler.nextArmed('once-only')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(calls).toHaveLength(1)
  })

  it('reports an expression with no occurrence inside the horizon as not armed', async () => {
    // Validation refuses an expression that never fires, so this is the guard
    // behind it: no occurrence found means no timer, and no silent nothing.
    const impossible = repeating('impossible', '0 0 30 2 *')
    const { scheduler, events, calls } = schedulerOf([impossible], async routine => wakeResult(routine.name))

    scheduler.armAll()

    expect(events).toEqual([{ outcome: 'not-armed', routine: impossible, detail: 'no future occurrence' }])
    expect(scheduler.nextArmed('impossible')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(calls).toEqual([])
  })

  it('dispose clears every armed timer', async () => {
    const frequent = repeating('frequent')
    const slower = repeating('slower', '*/5 * * * *')
    const { scheduler, events, calls } = schedulerOf([frequent, slower], async routine => wakeResult(routine.name))

    scheduler.armAll()
    scheduler.dispose()

    expect(scheduler.nextArmed('frequent')).toBeUndefined()
    expect(scheduler.nextArmed('slower')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(calls).toEqual([])
    // Disarming is silent: only the two armings were reported.
    expect(events.map(event => event.outcome)).toEqual(['armed', 'armed'])
  })

  it('runs two routines on their own grids', async () => {
    const everyMinute = repeating('every-minute')
    const everyFive = repeating('every-five', '*/5 * * * *')
    const { scheduler, calls } = schedulerOf([everyMinute, everyFive], async routine => wakeResult(routine.name))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.map(call => call.routine.name)).toEqual(['every-minute'])

    // The five-minute grid is untouched by the minutes around it: the routine
    // that fires every minute does not move the one that fires every fifth.
    expect(calls.map(call => call.firedAt)).toEqual([T + 60_000])
    await vi.advanceTimersByTimeAsync(240_000)
    expect(calls.map(call => call.firedAt).filter(at => at === T + 300_000)).toHaveLength(2)
    expect(scheduler.nextArmed('every-minute')).toBe(T + 360_000)
    expect(scheduler.nextArmed('every-five')).toBe(T + 600_000)
  })
})

describe('routine fire log', () => {
  const originalDshHome = process.env.DSH_HOME

  /** A throwaway home per test, so a fire log assertion reads only its own lines. */
  function freshHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'dsh-routines-spec-'))
    process.env.DSH_HOME = home
    return home
  }

  afterEach(() => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  })

  function records(path: string): RoutineFireRecord[] {
    return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as RoutineFireRecord)
  }

  it('appends one JSON line per fire, creating the directory', () => {
    const home = freshHome()
    const path = routines.routineFireLogPath()
    expect(path).toBe(join(home, 'agent-team', 'routines', 'fires.jsonl'))
    const warn = vi.fn()
    const appendFire = routines.createRoutineFireLog(path, warn)

    appendFire({ routine: 'hourly', member: 'tes', outcome: 'delivered', once: false, mode: 'followup', sessionId: SessionId('session:tes'), firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' })
    appendFire({ routine: 'nightly', member: 'tes', outcome: 'failed', reason: 'member-not-enabled', detail: 'suspended', firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' })

    expect(warn).not.toHaveBeenCalled()
    expect(records(path)).toEqual([
      { routine: 'hourly', member: 'tes', outcome: 'delivered', once: false, mode: 'followup', sessionId: 'session:tes', firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' },
      { routine: 'nightly', member: 'tes', outcome: 'failed', reason: 'member-not-enabled', detail: 'suspended', firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' },
    ])
  })

  it('trims an overgrown log to the newest 200 lines, keeping the fire that just happened', () => {
    freshHome()
    const path = routines.routineFireLogPath()
    mkdirSync(join(path, '..'), { recursive: true })
    // ~1 KiB per line: 300 lines is well past the 256 KiB cap.
    const filler = Array.from({ length: 300 }, (_, index) => JSON.stringify({ routine: `filler-${index}`, member: 'tes', outcome: 'failed', reason: 'wake-failed', detail: 'x'.repeat(1000), firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:00.000Z' }))
    writeFileSync(path, `${filler.join('\n')}\n`)

    const appendFire = routines.createRoutineFireLog(path, vi.fn())
    appendFire({ routine: 'hourly', member: 'tes', outcome: 'not-armed', detail: 'no future occurrence', recordedAt: '2026-09-25T00:00:01.000Z' })

    const kept = records(path)
    expect(kept).toHaveLength(200)
    expect(kept.at(-1)).toEqual({ routine: 'hourly', member: 'tes', outcome: 'not-armed', detail: 'no future occurrence', recordedAt: '2026-09-25T00:00:01.000Z' })
    // Newest survive: the oldest 101 lines went, `filler-101` is now the head.
    expect(kept[0]?.routine).toBe('filler-101')
  })

  it('warns instead of throwing when the log is unwritable, so a fire is never lost to its own record', () => {
    const home = freshHome()
    // A regular file where the log's directory would have to be.
    const blocked = join(home, 'blocked')
    writeFileSync(blocked, 'not a directory')
    const warn = vi.fn()
    const appendFire = routines.createRoutineFireLog(join(blocked, 'routines', 'fires.jsonl'), warn)

    expect(() => appendFire({ routine: 'hourly', member: 'tes', outcome: 'not-armed', detail: 'no future occurrence', recordedAt: '2026-09-25T00:00:01.000Z' })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/fire log is unwritable/)
  })
})

describe('agent-team routines row', () => {
  const originalDshHome = process.env.DSH_HOME

  function freshHome(): void {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-routines-row-'))
  }

  /** The Host methods the row calls; `wakeMember` answers synchronously. */
  type WakeMember = (request: AgentTeamWakeRequest) => AgentTeamWakeResult

  /** A Host service stub carrying the wake and the declaration hook the row calls. */
  function host(wakeMember: WakeMember,
    declareRoutines: (source: string, declarations: readonly RoutineConfig[]) => () => void = () => () => {}) {
    return { wakeMember, declareRoutines } as never
  }

  /** Mount the row the way the loader does, so its `inject` and `effect` are the real ones. */
  async function mount(ctx: Context, config?: routines.Config): Promise<void> {
    const loader = Object.create(Loader.prototype) as Loader
    const plugin = loader.unwrapExports(routines) as Parameters<Context['plugin']>[0]
    await ctx.plugin(plugin, config)
  }

  /** A Context whose logger is captured rather than exported. */
  function quietContext(): { ctx: Context; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
    const ctx = new Context()
    const info = vi.fn()
    const warn = vi.fn()
    vi.spyOn(ctx.logger, 'info').mockImplementation(info)
    vi.spyOn(ctx.logger, 'warn').mockImplementation(warn)
    return { ctx, info, warn }
  }

  function fireRecords(path: string): RoutineFireRecord[] {
    return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as RoutineFireRecord)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
    freshHome()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  })

  it('arms nothing and says so when the row carries no routines', async () => {
    const { ctx, info, warn } = quietContext()
    const wakeMember = vi.fn<WakeMember>()
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx)

    expect(info).toHaveBeenCalledWith(expect.stringContaining('no routines configured'))
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(wakeMember).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('wakes the configured target at its instant and records the fire', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('hourly'))
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx, {
      routines: [{ name: 'hourly', member: '@tes', prompt: 'check the model catalog', summary: 'Hourly catalog check', cron: '* * * * *' }],
    })
    const logPath = routines.routineFireLogPath()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember).toHaveBeenCalledTimes(1)
    expect(wakeMember.mock.calls[0]?.[0]).toMatchObject({
      handle: '@tes',
      routine: 'hourly',
      plugin: routines.name,
      summary: 'Hourly catalog check',
    })
    const request = wakeMember.mock.calls[0]?.[0]
    expect(request?.body.split('\n')[0]).toBe("[ROUTINE FIRE] hourly — fired 2026-09-25T08:01:00+08:00 (cron '* * * * *')")
    expect(request?.body).toContain('check the model catalog')
    expect(fireRecords(logPath)).toEqual([
      expect.objectContaining({ routine: 'hourly', member: 'tes', outcome: 'delivered', once: false, mode: 'followup', sessionId: 'session:tes', firedAt: '2026-09-25T00:01:00.000Z' }),
    ])
    await ctx.fiber.dispose()
  })

  it('arms a routine the store declares, so a GUI-created schedule needs no row edit', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('from-store'))
    ctx.provide('agentTeam', host(wakeMember))
    writeRoutineStore(routineStorePath(), [{ name: 'from-store', member: 'tes', prompt: 'check the queue', cron: '* * * * *' }])
    await mount(ctx)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember).toHaveBeenCalledTimes(1)
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'from-store', member: 'tes', outcome: 'delivered' }),
    ])
    await ctx.fiber.dispose()
  })

  it('lets the store own a name the row also declares, so one name arms one routine', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('shared'))
    ctx.provide('agentTeam', host(wakeMember))
    writeRoutineStore(routineStorePath(), [{ name: 'shared', member: 'tes', prompt: 'store wins', cron: '* * * * *' }])
    await mount(ctx, { routines: [{ name: 'shared', member: 'tes', prompt: 'config loses', cron: '0 0 1 1 *' }] })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember).toHaveBeenCalledTimes(1)
    expect(wakeMember.mock.calls[0]?.[0]).toMatchObject({ body: expect.stringContaining('store wins') })
    await ctx.fiber.dispose()
  })

  it('addresses a branded member id when the routine names one', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('targeted'))
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx, {
      routines: [{ name: 'targeted', member: `member:5b631fa5-cde1-4549-9dbc-2612779b1b84`, prompt: 'go', cron: '* * * * *' }],
    })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember.mock.calls[0]?.[0]).toMatchObject({ memberId: 'member:5b631fa5-cde1-4549-9dbc-2612779b1b84' })
    await ctx.fiber.dispose()
  })

  it('records a refused wake as failed with the Host reason', async () => {
    const { ctx, warn } = quietContext()
    ctx.provide('agentTeam', host(() => { throw new AgentTeamWakeDeliveryError('member-not-enabled', MEMBER_ID, 'tes', "Agent Member 'tes' is suspended; only an enabled Member can be woken") }))
    await mount(ctx, { routines: [{ name: 'nightly', member: 'tes', prompt: 'go', cron: '* * * * *' }] })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'nightly' not delivered (member-not-enabled)"))
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'nightly', member: 'tes', outcome: 'failed', reason: 'member-not-enabled' }),
    ])
    await ctx.fiber.dispose()
  })

  it('keeps a one-shot spent across a restart, so it fires once and not once per boot', async () => {
    // The expression has no year, so the fire log — not the declaration — is
    // what remembers that this one-shot already had its fire.
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('single'))
    ctx.provide('agentTeam', host(wakeMember))
    writeRoutineStore(routineStorePath(), [{ name: 'single', member: 'tes', prompt: 'go', cron: '* * * * *', once: true }])
    await mount(ctx)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(wakeMember).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()

    // The same Host comes back with the same store: the marker is in the log.
    const restarted = quietContext()
    const wakeAgain = vi.fn<WakeMember>(() => wakeResult('single'))
    restarted.ctx.provide('agentTeam', host(wakeAgain))
    await mount(restarted.ctx)

    expect(restarted.info).toHaveBeenCalledWith(expect.stringContaining("'single' already fired once"))
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(wakeAgain).not.toHaveBeenCalled()
    // A spent one-shot is the expected end of a routine rather than an anomaly,
    // so it adds no line to the fire log it was read from.
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'single', outcome: 'delivered', once: true }),
    ])
    await restarted.ctx.fiber.dispose()
  })

  it('re-arms a one-shot once its declaration is saved again under the same name', async () => {
    // Deleting and re-saving is how a spent one-shot is asked for a second time.
    const { ctx, info } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('again'))
    ctx.provide('agentTeam', host(wakeMember))
    writeRoutineStore(routineStorePath(), [{ name: 'again', member: 'tes', prompt: 'go', cron: '* * * * *' }])
    await mount(ctx)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wakeMember).toHaveBeenCalledTimes(1)

    // The store watcher re-arms the whole list on a change, and a live routine
    // is not a spent one — only a delivered `once` marks a name.
    writeRoutineStore(routineStorePath(), [{ name: 'again', member: 'tes', prompt: 'go', cron: '* * * * *', once: true }])
    await vi.advanceTimersByTimeAsync(60_000)

    expect(info).toHaveBeenCalledWith(expect.stringContaining("'again' armed"))
    await ctx.fiber.dispose()
  })

  it('waits for the Host service when the row mounts first, then arms', async () => {
    const { ctx, info } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('late'))
    await mount(ctx, { routines: [{ name: 'late', member: 'tes', prompt: 'go', cron: '* * * * *' }] })
    expect(info).not.toHaveBeenCalled()
    expect(wakeMember).not.toHaveBeenCalled()

    ctx.provide('agentTeam', host(wakeMember))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('clears its timers when the row unmounts', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('hourly'))
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx, { routines: [{ name: 'hourly', member: 'tes', prompt: 'go', cron: '* * * * *' }] })

    await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)

    expect(wakeMember).not.toHaveBeenCalled()
  })

  it('publishes its own declarations to the Host and withdraws them when the row unmounts', async () => {
    const { ctx } = quietContext()
    const published: Array<{ source: string; declarations: readonly RoutineConfig[] }> = []
    const withdraw = vi.fn()
    ctx.provide('agentTeam', host(vi.fn<WakeMember>(), (source, declarations) => {
      published.push({ source, declarations })
      return withdraw
    }))
    await mount(ctx, { routines: [{ name: 'hourly', member: 'tes', prompt: 'go', cron: '* * * * *' }] })

    // The row owns its own `config.routines`: it publishes them so the routine
    // API reports them as declared on this row rather than saved into the store,
    // and refuses to save over a name they own.
    expect(published).toHaveLength(1)
    expect(published[0]!.source).toBe(routines.name)
    expect(published[0]!.declarations).toEqual([{ name: 'hourly', member: 'tes', prompt: 'go', cron: '* * * * *' }])
    expect(withdraw).not.toHaveBeenCalled()

    await ctx.fiber.dispose()
    expect(withdraw).toHaveBeenCalledTimes(1)
  })

  it('refuses an unrunnable schedule while the row mounts, so a typo cannot fail silently later', async () => {
    const { ctx } = quietContext()
    ctx.provide('agentTeam', host(() => wakeResult('bad')))
    await expect(mount(ctx, { routines: [{ name: 'bad name', member: 'tes', prompt: 'go', cron: '* * * * *' }] })).rejects.toThrow(/\.name must match/)
    await expect(mount(ctx, { routines: [{ name: 'never', member: 'tes', prompt: 'go', cron: '0 0 30 2 *' }] })).rejects.toThrow(/never fires within five years/)
    await ctx.fiber.dispose()
  })
})
