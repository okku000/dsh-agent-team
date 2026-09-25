import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Storage } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import { readStoredRoutines, routineStorePath, writeRoutineStore } from '../src/routine-store.ts'
import * as routines from '../src/routines.ts'
import { routineFireLogPath, type RoutineFireRecord } from '../src/routines.ts'
import type { RoutineConfig } from '../src/routine-schedule.ts'
import type { AgentTeamChannelRef, AgentTeamRequestId } from '../src/types.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

/**
 * The Host routine API: the schedule the Web Client and every Agent tool write
 * through. What matters here is that a save lands in the same store the producer
 * reads, that the running Host arms it without a restart, that a refusal leaves
 * the routines that already run untouched, and that an operator's own
 * declaration is reported as theirs rather than quietly shadowed.
 */

const alpha = WorkspaceId('workspace:alpha')
const CHANNEL = 'channel:046dd831-c679-4279-b6aa-7813476cf12e' as AgentTeamChannelRef
const HUMAN = { kind: 'human', memberId: AGENT_TEAM_HUMAN_MEMBER_ID, handle: 'human' }
const cleanups: Array<() => Promise<void>> = []
const originalDshHome = process.env.DSH_HOME

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

/** A post routine targeting the one Channel this Host knows. */
function post(overrides: Partial<RoutineConfig> = {}): RoutineConfig {
  return { name: 'standup', kind: 'post', workspaceId: alpha, channel: CHANNEL, body: 'report your progress', mentions: ['scout'], everySeconds: 3600, ...overrides }
}

/** Mount the producer row the way the loader does, so its `inject` and `effect` are the real ones. */
async function mountProducer(ctx: Context, config?: routines.Config): Promise<void> {
  const loader = Object.create(Loader.prototype) as Loader
  const plugin = loader.unwrapExports(routines) as Parameters<Context['plugin']>[0]
  await ctx.plugin(plugin, config)
}

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-routine-host-'))
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

describe('the Host routine API', () => {
  it('saves, lists, and deletes a routine a Human created, with the Human on it', async () => {
    const ctx = await harness()
    const team = ctx.agentTeam

    const saved = team.saveRoutine({ workspaceId: alpha, routine: post() })
    expect(saved.created).toBe(true)
    expect(saved.routine).toMatchObject({
      name: 'standup', origin: 'store', createdBy: HUMAN,
      declaration: { kind: 'post', channel: CHANNEL, body: 'report your progress', mentions: ['scout'], everySeconds: 3600 },
    })
    // The declaration the API reports is the entry the producer reads back.
    expect(readStoredRoutines(routineStorePath())[0]).toMatchObject({ name: 'standup', createdBy: HUMAN, kind: 'post' })
    expect(team.routines({ workspaceId: alpha }).routines).toEqual([saved.routine])

    const replaced = team.saveRoutine({ workspaceId: alpha, routine: post({ body: 'report your progress, briefly' }) })
    expect(replaced.created).toBe(false)
    expect(replaced.routine).toMatchObject({ createdBy: HUMAN })
    // A replacement records the new save without claiming to have created it.
    expect(replaced.routine.createdAt).toBe(saved.routine.createdAt)
    expect(replaced.routine.updatedBy).toEqual(HUMAN)
    expect(typeof replaced.routine.updatedAt).toBe('string')
    expect(replaced.routine.declaration).toMatchObject({ body: 'report your progress, briefly' })
    expect(team.routines({ workspaceId: alpha }).routines).toEqual([replaced.routine])

    expect(team.deleteRoutine({ workspaceId: alpha, name: 'standup' })).toEqual({ name: 'standup', removed: true })
    expect(team.routines({ workspaceId: alpha }).routines).toEqual([])
    expect(team.deleteRoutine({ workspaceId: alpha, name: 'standup' })).toEqual({ name: 'standup', removed: false })
    team.validateLedger()
  })

  it('reports an operator declaration as declared there and refuses to shadow or delete it', async () => {
    const ctx = await harness()
    const team = ctx.agentTeam
    const declared: RoutineConfig = { name: 'nightly-sweep', member: 'scout', prompt: 'check the model catalog', everySeconds: 86400 }
    const withdraw = team.declareRoutines('wowyuarm-agent-team-routines', [declared])

    expect(team.routines({ workspaceId: alpha }).routines).toEqual([{ name: 'nightly-sweep', origin: 'config', declaration: declared }])
    expect(() => team.saveRoutine({ workspaceId: alpha, routine: post({ name: 'nightly-sweep' }) })).toThrow(/declared by the operator on the 'wowyuarm-agent-team-routines' row/)
    expect(() => team.deleteRoutine({ workspaceId: alpha, name: 'nightly-sweep' })).toThrow(/is not in the routine store/)
    expect(readStoredRoutines(routineStorePath())).toEqual([])

    // The row unloading withdraws its own declaration, and the name is free again.
    withdraw()
    expect(team.routines({ workspaceId: alpha }).routines).toEqual([])
    expect(team.saveRoutine({ workspaceId: alpha, routine: post({ name: 'nightly-sweep' }) }).created).toBe(true)
  })

  it('refuses a post routine that targets another Workspace', async () => {
    const ctx = await harness()
    expect(() => ctx.agentTeam.saveRoutine({ workspaceId: alpha, routine: post({ workspaceId: 'workspace:beta' }) })).toThrow(/must be 'workspace:alpha'/)
    // The Channel ref is resolved when the routine fires, not when it is saved:
    // an unresolvable ref is a recorded fire refusal rather than a silent no-op.
    expect(readStoredRoutines(routineStorePath())).toEqual([])
  })

  it('refuses a declaration the Host cannot run and leaves the routines that already run untouched', async () => {
    const ctx = await harness()
    const team = ctx.agentTeam
    team.saveRoutine({ workspaceId: alpha, routine: post() })
    const before = readFileSync(routineStorePath(), 'utf8')
    expect(() => team.saveRoutine({ workspaceId: alpha, routine: post({ name: 'broken', everySeconds: 1 }) })).toThrow(/everySeconds/)
    expect(() => team.saveRoutine({ workspaceId: alpha, routine: { name: 'no-trigger', member: 'scout', prompt: 'check' } })).toThrow(/exactly one trigger/)
    expect(() => team.saveRoutine({ workspaceId: alpha, routine: { name: 'bad name', member: 'scout', prompt: 'check', everySeconds: 60 } })).toThrow(/name must match/)
    expect(readFileSync(routineStorePath(), 'utf8')).toBe(before)
    expect(team.routines({ workspaceId: alpha }).routines.map(entry => entry.name)).toEqual(['standup'])
  })

  it('reports a store it cannot read instead of an empty schedule', async () => {
    const ctx = await harness()
    // An operator edited the file by hand and broke it: the API says so rather
    // than reporting a Host with no routines at all.
    writeRoutineStore(routineStorePath(), [post()])
    writeFileSync(routineStorePath(), 'not json at all')
    expect(() => ctx.agentTeam.routines({ workspaceId: alpha })).toThrow(/unusable/)
  })

  it('arms a routine this Host saves while the producer row is already running', async () => {
    const ctx = await harness()
    const team = ctx.agentTeam
    const created = await team.createChannel({ requestId: 'routine-arm' as AgentTeamRequestId, workspaceId: alpha, name: 'engineering', description: '' })
    await mountProducer(ctx, undefined)

    // No restart and no reload: the row that is already running re-reads the
    // store the moment the Host writes it, which is what a routine created from
    // the Web Client or by an Agent Member has to mean.
    team.saveRoutine({ workspaceId: alpha, routine: {
      name: 'armed-live', kind: 'post', workspaceId: alpha, channel: created.channel.channelRef,
      body: 'the nightly build is green', at: new Date(Date.now() + 400).toISOString(),
    } })

    const fired = await waitForFireLog()
    expect(fired).toMatchObject({ routine: 'armed-live', channel: created.channel.channelRef, outcome: 'posted' })
  }, 10_000)
})

/** Wait for the producer to append one fire record, however long the store watcher takes. */
async function waitForFireLog(timeoutMs = 5000): Promise<RoutineFireRecord | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(routineFireLogPath(), 'utf8').trim()
      if (text !== '') return JSON.parse(text.split('\n').at(-1)!) as RoutineFireRecord
    } catch {
      // No log yet: the routine has not fired.
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return undefined
}
