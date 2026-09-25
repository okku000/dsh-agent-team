import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Storage } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTeamWakeDeliveryError, type AgentTeamWakeMode, type AgentTeamWakeRequest, type AgentTeamWakeResult } from '../src/member-wake.ts'
import { routineStorePath, writeRoutineStore } from '../src/routine-store.ts'
import type { PostAction, PostRoutine, Routine, WakeRoutine } from '../src/routine-schedule.ts'
import * as routines from '../src/routines.ts'
import type { RoutineFireRecord, RoutinePostResult } from '../src/routines.ts'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import type {
  AgentTeamChannelRef, AgentTeamMemberId, AgentTeamMessageRef, AgentTeamOperationId, AgentTeamRequestId,
  AgentTeamSendMessageRequest, AgentTeamSendMessageResult, AgentTeamThreadRef,
} from '../src/types.ts'

/**
 * The built-in routine producer: the schedule's timers, the fire log, and the
 * row that wires them to the Host's wake and to its Message commit. The
 * arithmetic itself is covered by `routine-schedule.spec.ts`; what matters here
 * is what an unattended fire leaves behind — the armed instant, the phase after
 * a slow delivery, the record of a refusal, and a log that cannot break the Host.
 */

const T = Date.parse('2026-09-25T00:00:00.000Z')
const MEMBER_ID = 'member:tes' as AgentTeamMemberId
const SENDER_ID = 'member:human' as AgentTeamMemberId
const WORKSPACE_ID = 'workspace:6f0d0f7c-4f4b-4a5e-8a1e-1f2b3c4d5e6f' as WorkspaceId
const CHANNEL_REF = 'channel:2b8c9d0e-1a2b-4c3d-9e4f-5a6b7c8d9e0f' as AgentTeamChannelRef
const THREAD_REF = 'thread:1c2d3e4f-0000-4000-8000-000000000001' as AgentTeamThreadRef
const MESSAGE_REF = 'message:1c2d3e4f-0000-4000-8000-000000000002' as AgentTeamMessageRef

/** A validated repeating wake routine, so the timers can be driven without the config layer. */
function repeating(name: string, everySeconds: number, overrides: Partial<WakeRoutine> = {}): WakeRoutine {
  return { name, action: { kind: 'wake', member: 'tes', prompt: 'check the model catalog' }, once: false, everySeconds, ...overrides }
}

/** A validated one-shot wake routine. */
function oneShot(name: string, at: number): WakeRoutine {
  return { name, action: { kind: 'wake', member: 'tes', prompt: 'check the model catalog' }, once: false, at }
}

/** A validated post action, so the post lane can be driven without the config layer. */
function postAction(overrides: Partial<PostAction> = {}): PostAction {
  return { kind: 'post', workspaceId: WORKSPACE_ID, channel: CHANNEL_REF, mentions: [], body: 'report your progress', asTask: false, ...overrides }
}

/** A validated repeating post routine. */
function posting(name: string, everySeconds: number, overrides: Partial<PostAction> = {}): PostRoutine {
  return { name, action: postAction(overrides), once: false, everySeconds }
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
 * only what it drives. The wake lane is the one nearly every test drives; a post
 * routine goes through {@link postSchedulerOf}.
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
      return { action: 'wake', result: await wake(routine, firedAt) }
    },
    onEvent: event => { events.push(event) },
  })
  return { scheduler, events, calls }
}

/** One scheduler delivering every fire through the post lane. */
function postSchedulerOf(
  routinesToRun: readonly Routine[],
  post: (routine: Routine, firedAt: number) => Promise<RoutinePostResult>,
) {
  const events: routines.RoutineEvent[] = []
  const scheduler = new routines.RoutineScheduler({
    routines: routinesToRun,
    deliver: async (routine, firedAt) => ({ action: 'post', result: await post(routine, firedAt) }),
    onEvent: event => { events.push(event) },
  })
  return { scheduler, events }
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

  it('reports a post fire as posted, carrying the Thread and Message it committed', async () => {
    const standup = posting('standup', 60)
    const committed: RoutinePostResult = { channelRef: CHANNEL_REF, threadRef: THREAD_REF, messageRef: MESSAGE_REF }
    const { scheduler, events } = postSchedulerOf([standup], async () => committed)

    scheduler.armAll()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(events).toEqual([
      { outcome: 'armed', routine: standup, next: T + 60_000 },
      { outcome: 'posted', routine: standup, firedAt: T + 60_000, result: committed },
      { outcome: 'armed', routine: standup, next: T + 120_000 },
    ])
  })

  it('names a post refusal after the lane that failed, not after the wake it is not', async () => {
    const standup = posting('standup', 60)
    const { scheduler, events } = postSchedulerOf([standup], async () => { throw new Error('Channel is archived') })

    await expect(scheduler.fire(standup)).resolves.toBeUndefined()

    expect(events[0]).toEqual({ outcome: 'failed', routine: standup, firedAt: T, reason: 'post-failed', detail: 'Channel is archived' })
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
    appendFire({ routine: 'standup', channel: CHANNEL_REF, outcome: 'posted', threadRef: THREAD_REF, messageRef: MESSAGE_REF, firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' })
    appendFire({ routine: 'nightly', member: 'tes', outcome: 'failed', reason: 'member-not-enabled', detail: 'suspended', firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' })

    expect(warn).not.toHaveBeenCalled()
    expect(records(path)).toEqual([
      { routine: 'hourly', member: 'tes', outcome: 'delivered', mode: 'followup', sessionId: 'session:tes', firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' },
      { routine: 'standup', channel: CHANNEL_REF, outcome: 'posted', threadRef: THREAD_REF, messageRef: MESSAGE_REF, firedAt: '2026-09-25T00:00:00.000Z', recordedAt: '2026-09-25T00:00:01.000Z' },
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

  /** The two Host methods the row calls; `wakeMember` answers synchronously. */
  type WakeMember = (request: AgentTeamWakeRequest) => AgentTeamWakeResult
  type SendMessage = (request: AgentTeamSendMessageRequest) => Promise<AgentTeamSendMessageResult>

  /** What the Host reports for a committed top-level post. */
  function postedResult(request: AgentTeamSendMessageRequest): AgentTeamSendMessageResult {
    const occurredAt = new Date(T).toISOString()
    return {
      kind: 'committed',
      receipt: { operationId: 'operation:routine' as AgentTeamOperationId, requestId: request.requestId, sequence: 4, occurredAt },
      message: {
        messageRef: MESSAGE_REF, channelRef: CHANNEL_REF, threadRef: THREAD_REF, sender: SENDER_ID,
        body: request.body, topLevel: true, sequence: 4, occurredAt,
      },
      thread: { threadRef: THREAD_REF, revision: 4 },
      attention: [],
      directMarkers: [],
    }
  }

  /** A Host service stub carrying only the wake and the post the row calls. */
  function host(wakeMember: WakeMember, sendMessage: SendMessage = async () => { throw new Error('this Host cannot post') }) {
    return { wakeMember, sendMessage } as never
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
    const request = wakeMember.mock.calls[0]?.[0]
    expect(request?.body.split('\n')[0]).toBe('[ROUTINE FIRE] hourly — fired 2026-09-25T09:00:00+08:00')
    expect(request?.body).toContain('check the model catalog')
    expect(fireRecords(logPath)).toEqual([
      expect.objectContaining({ routine: 'hourly', member: 'tes', outcome: 'delivered', mode: 'followup', sessionId: 'session:tes', firedAt: '2026-09-25T01:00:00.000Z' }),
    ])
    await ctx.fiber.dispose()
  })

  it('arms a routine the store declares, so a GUI-created schedule needs no row edit', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('from-store'))
    ctx.provide('agentTeam', host(wakeMember))
    writeRoutineStore(routineStorePath(), [{ name: 'from-store', member: 'tes', prompt: 'check the queue', everySeconds: 60 }])
    await mount(ctx)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember).toHaveBeenCalledTimes(1)
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'from-store', member: 'tes', outcome: 'delivered' }),
    ])
    await ctx.fiber.dispose()
  })

  it('posts a routine into its Channel, mentioning the Member its body has to wake', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>()
    const sendMessage = vi.fn<SendMessage>(async request => postedResult(request))
    ctx.provide('agentTeam', host(wakeMember, sendMessage))
    writeRoutineStore(routineStorePath(), [{
      name: 'standup', kind: 'post', workspaceId: WORKSPACE_ID, channel: CHANNEL_REF,
      mentions: ['tes'], body: 'report your progress', everySeconds: 60,
    }])
    await mount(ctx)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(wakeMember).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const request = sendMessage.mock.calls[0]?.[0]
    // The mention is what wakes the Member, so it has to be in the body the
    // ledger scans — the row never passes a recipient list of its own.
    expect(request).toMatchObject({ workspaceId: WORKSPACE_ID, channelRef: CHANNEL_REF, body: '@tes report your progress', asTask: false })
    expect(request?.requestId).toBe(`routine:standup:${T + 60_000}`)
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'standup', channel: CHANNEL_REF, outcome: 'posted', threadRef: THREAD_REF, messageRef: MESSAGE_REF }),
    ])
    await ctx.fiber.dispose()
  })

  it('records a post the Host refuses as failed, naming the Channel it posted to', async () => {
    const { ctx, warn } = quietContext()
    const sendMessage = vi.fn<SendMessage>(async () => { throw new Error(`Agent Member '${MEMBER_ID}' is not authorized for Channel '${CHANNEL_REF}'`) })
    ctx.provide('agentTeam', host(vi.fn<WakeMember>(), sendMessage))
    await mount(ctx, {
      routines: [{ name: 'standup', kind: 'post', workspaceId: WORKSPACE_ID, channel: CHANNEL_REF, body: 'report your progress', everySeconds: 60 }],
    })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'standup' not delivered (post-failed)"))
    expect(fireRecords(routines.routineFireLogPath())).toEqual([
      expect.objectContaining({ routine: 'standup', channel: CHANNEL_REF, outcome: 'failed', reason: 'post-failed' }),
    ])
    await ctx.fiber.dispose()
  })

  it('lets the store own a name the row also declares, so one name arms one routine', async () => {
    const { ctx } = quietContext()
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('shared'))
    ctx.provide('agentTeam', host(wakeMember))
    writeRoutineStore(routineStorePath(), [{ name: 'shared', member: 'tes', prompt: 'store wins', everySeconds: 60 }])
    await mount(ctx, { routines: [{ name: 'shared', member: 'tes', prompt: 'config loses', everySeconds: 3600 }] })

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
    const wakeMember = vi.fn<WakeMember>()
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
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('late'))
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
    const wakeMember = vi.fn<WakeMember>(() => wakeResult('hourly'))
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

/**
 * The post lane against a real Team Host: a stub proves the request the row
 * builds, but only the ledger can prove that request is one the Host accepts —
 * that a taskless Thread is created, that the Human is the sender, and that the
 * committed refs are what the fire log records.
 */
describe('a posted routine over a real Team Host', () => {
  const originalDshHome = process.env.DSH_HOME
  const alpha = WorkspaceId('workspace:alpha')
  const cleanups: Array<() => Promise<void>> = []

  /** A Host over a throwaway storage backend, with one Workspace and no Agent Members. */
  async function harness(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('workspaceRegistry', {
      get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} } : undefined,
      list: () => [{ id: alpha, path: process.cwd() }],
      archiveSession: async () => {},
    })
    ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
    ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
    ctx.provide('tools', { schemas: () => [] })
    ctx.provide('sessionPersistence', { list: async () => [] })
    await ctx.plugin(SessionProjectionRegistry)
    const team = await ctx.plugin(AgentTeam)
    cleanups.push(async () => { await team.dispose(); await facility.closeAll() })
    return ctx
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T)
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-routines-live-'))
  })

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
    vi.useRealTimers()
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  })

  /** Mount the row the way the loader does, so its `inject` and `effect` are the real ones. */
  async function mount(ctx: Context, config?: routines.Config): Promise<void> {
    const loader = Object.create(Loader.prototype) as Loader
    const plugin = loader.unwrapExports(routines) as Parameters<Context['plugin']>[0]
    await ctx.plugin(plugin, config)
  }

  it('commits a taskless Message as the Human and records the refs it landed on', async () => {
    const ctx = await harness()
    const team = ctx.agentTeam
    const created = await team.createChannel({ requestId: 'post-channel' as AgentTeamRequestId, workspaceId: alpha, name: 'engineering', description: '' })
    const channelRef = created.channel.channelRef
    writeRoutineStore(routineStorePath(), [{
      name: 'standup', kind: 'post', workspaceId: alpha, channel: channelRef,
      body: 'the nightly build is green', everySeconds: 60,
    }])
    await mount(ctx, undefined)

    await vi.advanceTimersByTimeAsync(60_000)
    // The commit runs through the ledger's own queue, so let it settle.
    await vi.advanceTimersByTimeAsync(0)

    const [record] = readFileSync(routines.routineFireLogPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line) as RoutineFireRecord)
    expect(record).toMatchObject({ routine: 'standup', channel: channelRef, outcome: 'posted' })
    if (record?.outcome !== 'posted') throw new Error(`expected a posted record, received '${record?.outcome}'`)

    const read = await team.readThread({ requestId: 'read-posted' as AgentTeamRequestId, workspaceId: alpha, threadRef: record.threadRef as AgentTeamThreadRef })
    // A routine posts as the Human who created it, into a Thread of its own.
    expect(read.anchor).toMatchObject({
      sender: AGENT_TEAM_HUMAN_MEMBER_ID,
      body: 'the nightly build is green',
      topLevel: true,
    })
    expect(read.thread.taskRef).toBeUndefined()
  })
})
