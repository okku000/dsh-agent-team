import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTeamWakeDeliveryError, type AgentTeamWakeMode, type AgentTeamWakeResult } from '../src/member-wake.ts'
import * as routines from '../src/routines.ts'
import type { Routine, RoutineFireRecord } from '../src/routines.ts'
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

/** A validated repeating routine, so the timers can be driven without the config layer. */
function repeating(name: string, everySeconds: number, overrides: Partial<Routine> = {}): Routine {
  return { name, member: 'tes', prompt: 'check the model catalog', once: false, everySeconds, ...overrides }
}

/** A validated one-shot routine. */
function oneShot(name: string, at: number): Routine {
  return { name, member: 'tes', prompt: 'check the model catalog', once: false, at }
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

/** One scheduler with its events and wake calls recorded, so a test states only what it drives. */
function schedulerOf(
  routinesToRun: readonly Routine[],
  wake: (routine: Routine, firedAt: number) => Promise<AgentTeamWakeResult>,
) {
  const events: routines.RoutineEvent[] = []
  const calls: Fired[] = []
  const scheduler = new routines.RoutineScheduler({
    routines: routinesToRun,
    wake: (routine, firedAt) => {
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
    const hourly = repeating('hourly', 3600)
    const soon = oneShot('soon', T + 120_000)
    const { scheduler, events, calls } = schedulerOf([hourly, soon], async routine => wakeResult(routine.name))

    scheduler.armAll()

    expect(events).toEqual([
      { outcome: 'armed', routine: hourly, next: T + 3_600_000 },
      { outcome: 'armed', routine: soon, next: T + 120_000 },
    ])
    expect(scheduler.nextArmed('hourly')).toBe(T + 3_600_000)
    expect(scheduler.nextArmed('soon')).toBe(T + 120_000)

    await vi.advanceTimersByTimeAsync(119_999)
    expect(calls).toEqual([])
  })

  it('delivers at the armed instant and re-arms the repeat on its grid', async () => {
    const hourly = repeating('hourly', 3600)
    const { scheduler, events, calls } = schedulerOf([hourly], async routine => wakeResult(routine.name, 'steer'))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(3_600_000)

    expect(calls).toEqual([{ routine: hourly, firedAt: T + 3_600_000 }])
    expect(events).toEqual([
      { outcome: 'armed', routine: hourly, next: T + 3_600_000 },
      { outcome: 'delivered', routine: hourly, firedAt: T + 3_600_000, result: wakeResult('hourly', 'steer') },
      { outcome: 'armed', routine: hourly, next: T + 7_200_000 },
    ])
    // The next instant is the grid's, one interval after the one that fired.
    expect(scheduler.nextArmed('hourly')).toBe(T + 7_200_000)
  })

  it('re-arms a repeat from the instant it was due, so a slow delivery cannot push the phase', async () => {
    let settle: ((result: AgentTeamWakeResult) => void) | undefined
    const hourly = repeating('hourly', 3600)
    const { scheduler, calls } = schedulerOf([hourly], () => new Promise(resolve => { settle = resolve }))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls).toHaveLength(1)
    // In flight: the routine holds no timer, so nothing can fire over the wake.
    expect(scheduler.nextArmed('hourly')).toBeUndefined()

    // Five minutes of delivery time, then a settled wake.
    await vi.advanceTimersByTimeAsync(300_000)
    settle?.(wakeResult('hourly'))
    await vi.advanceTimersByTimeAsync(0)

    // Still the grid: the next instant hangs off the due instant (T + 1h), not
    // off the moment this wake settled (T + 1h5m).
    expect(scheduler.nextArmed('hourly')).toBe(T + 7_200_000)
  })

  it('records a refused wake as failed with its reason, and still re-arms the repeat', async () => {
    const everyMinute = repeating('every-minute', 60)
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
    const hourly = repeating('hourly', 3600)
    const { scheduler, events } = schedulerOf([hourly], async () => { throw new Error('the Host is on fire') })

    await expect(scheduler.fire(hourly)).resolves.toBeUndefined()
    // Fired directly (no arming first), so the failure precedes the re-arm.
    expect(events.map(event => event.outcome)).toEqual(['failed', 'armed'])
    expect(events[0]).toEqual({ outcome: 'failed', routine: hourly, firedAt: T, reason: 'wake-failed', detail: 'the Host is on fire' })
    expect(scheduler.nextArmed('hourly')).toBe(T + 3_600_000)
  })

  it('disarms a routine declared once after its first delivery', async () => {
    const once = repeating('once-only', 3600, { once: true })
    const { scheduler, calls } = schedulerOf([once], async routine => wakeResult(routine.name))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(3_600_000)

    expect(calls).toHaveLength(1)
    expect(scheduler.nextArmed('once-only')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(calls).toHaveLength(1)
  })

  it('reports a one-shot whose instant already passed as not armed, instead of arming a past timer', async () => {
    const spent = oneShot('spent', T - 60_000)
    const { scheduler, events, calls } = schedulerOf([spent], async routine => wakeResult(routine.name))

    scheduler.armAll()

    expect(events).toEqual([{ outcome: 'not-armed', routine: spent, detail: 'no future occurrence' }])
    expect(scheduler.nextArmed('spent')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(calls).toEqual([])
  })

  it('dispose clears every armed timer', async () => {
    const hourly = repeating('hourly', 3600)
    const soon = oneShot('soon', T + 60_000)
    const { scheduler, events, calls } = schedulerOf([hourly, soon], async routine => wakeResult(routine.name))

    scheduler.armAll()
    scheduler.dispose()

    expect(scheduler.nextArmed('hourly')).toBeUndefined()
    expect(scheduler.nextArmed('soon')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(calls).toEqual([])
    // Disarming is silent: only the two armings were reported.
    expect(events.map(event => event.outcome)).toEqual(['armed', 'armed'])
  })

  it('runs two routines on their own grids', async () => {
    const everyMinute = repeating('every-minute', 60)
    const everyTwo = repeating('every-two', 120)
    const { scheduler, calls } = schedulerOf([everyMinute, everyTwo], async routine => wakeResult(routine.name))

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.map(call => call.routine.name)).toEqual(['every-minute'])

    // Both are due at T + 2m, so the batch carries one fire each; the order
    // inside a same-instant batch is the timer scheduler's, not the declaration's.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.map(call => call.routine.name).filter(name => name === 'every-minute')).toHaveLength(2)
    expect(calls.map(call => call.routine.name).filter(name => name === 'every-two')).toHaveLength(1)
    expect(calls.map(call => call.firedAt)).toEqual([T + 60_000, T + 120_000, T + 120_000])
    expect(scheduler.nextArmed('every-minute')).toBe(T + 180_000)
    expect(scheduler.nextArmed('every-two')).toBe(T + 240_000)
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

    appendFire({ routine: 'hourly', member: 'tes', outcome: 'delivered', mode: 'followup', sessionId: SessionId('session:tes'), firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' })
    appendFire({ routine: 'nightly', member: 'tes', outcome: 'failed', reason: 'member-not-enabled', detail: 'suspended', firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' })

    expect(warn).not.toHaveBeenCalled()
    expect(records(path)).toEqual([
      { routine: 'hourly', member: 'tes', outcome: 'delivered', mode: 'followup', sessionId: 'session:tes', firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' },
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

  /** A Host service stub with only the wake the row calls. */
  function host(wakeMember: (request: unknown) => AgentTeamWakeResult) {
    return { wakeMember } as never
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
    const wakeMember = vi.fn()
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
    const wakeMember = vi.fn(() => wakeResult('hourly'))
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx, {
      routines: [{ name: 'hourly', member: '@tes', prompt: 'check the model catalog', summary: 'Hourly catalog check', everySeconds: 3600 }],
    })
    const logPath = routines.routineFireLogPath()

    await vi.advanceTimersByTimeAsync(3_600_000)

    expect(wakeMember).toHaveBeenCalledTimes(1)
    expect(wakeMember.mock.calls[0]?.[0]).toMatchObject({
      handle: '@tes',
      routine: 'hourly',
      plugin: routines.name,
      summary: 'Hourly catalog check',
    })
    const request = wakeMember.mock.calls[0]?.[0] as { readonly body: string }
    expect(request.body.split('\n')[0]).toBe('[ROUTINE FIRE] hourly — fired 2026-09-25T09:00:00+08:00')
    expect(request.body).toContain('check the model catalog')
    expect(fireRecords(logPath)).toEqual([
      expect.objectContaining({ routine: 'hourly', member: 'tes', outcome: 'delivered', mode: 'followup', sessionId: 'session:tes', firedAt: '2026-09-25T01:00:00.000Z' }),
    ])
    await ctx.fiber.dispose()
  })

  it('addresses a branded member id when the routine names one', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn(() => wakeResult('targeted'))
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx, {
      routines: [{ name: 'targeted', member: `member:5b631fa5-cde1-4549-9dbc-2612779b1b84`, prompt: 'go', everySeconds: 60 }],
    })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember.mock.calls[0]?.[0]).toMatchObject({ memberId: 'member:5b631fa5-cde1-4549-9dbc-2612779b1b84' })
    await ctx.fiber.dispose()
  })

  it('records a refused wake as failed with the Host reason', async () => {
    const { ctx, warn } = quietContext()
    ctx.provide('agentTeam', host(() => { throw new AgentTeamWakeDeliveryError('member-not-enabled', MEMBER_ID, 'tes', "Agent Member 'tes' is suspended; only an enabled Member can be woken") }))
    await mount(ctx, { routines: [{ name: 'nightly', member: 'tes', prompt: 'go', everySeconds: 60 }] })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'nightly' not delivered (member-not-enabled)"))
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'nightly', member: 'tes', outcome: 'failed', reason: 'member-not-enabled' }),
    ])
    await ctx.fiber.dispose()
  })

  it('records and warns about a one-shot whose instant passed while the Host was down', async () => {
    const { ctx, info, warn } = quietContext()
    const wakeMember = vi.fn()
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx, { routines: [{ name: 'spent', member: 'tes', prompt: 'go', at: '2026-09-24T00:00:00+08:00' }] })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'spent' has no future occurrence"))
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('armed'))
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'spent', outcome: 'not-armed', detail: 'no future occurrence' }),
    ])
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(wakeMember).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('waits for the Host service when the row mounts first, then arms', async () => {
    const { ctx, info } = quietContext()
    const wakeMember = vi.fn(() => wakeResult('late'))
    await mount(ctx, { routines: [{ name: 'late', member: 'tes', prompt: 'go', everySeconds: 60 }] })
    expect(info).not.toHaveBeenCalled()
    expect(wakeMember).not.toHaveBeenCalled()

    ctx.provide('agentTeam', host(wakeMember))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('clears its timers when the row unmounts', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn(() => wakeResult('hourly'))
    ctx.provide('agentTeam', host(wakeMember))
    await mount(ctx, { routines: [{ name: 'hourly', member: 'tes', prompt: 'go', everySeconds: 3600 }] })

    await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)

    expect(wakeMember).not.toHaveBeenCalled()
  })

  it('refuses an unrunnable schedule while the row mounts, so a typo cannot fail silently later', async () => {
    const { ctx } = quietContext()
    ctx.provide('agentTeam', host(() => wakeResult('bad')))
    await expect(mount(ctx, { routines: [{ name: 'bad name', member: 'tes', prompt: 'go', everySeconds: 60 }] })).rejects.toThrow(/\.name must match/)
    await ctx.fiber.dispose()
  })
})
