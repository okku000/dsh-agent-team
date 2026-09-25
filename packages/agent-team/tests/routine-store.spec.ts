import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteStoredRoutine, mergeRoutines, readRoutineStore, readStoredRoutines, routineStoreTemporaryPath, saveStoredRoutine, watchRoutineStore, writeRoutineStore } from '../src/routine-store.ts'
import type { RoutineConfig } from '../src/routine-schedule.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import type { AgentTeamMemberId } from '../src/types.ts'

/**
 * The durable routine store: what an operator creates from the GUI. What matters
 * here is that a second way of writing the same declaration never becomes a
 * second definition of it, that an unusable store costs the schedule nothing,
 * and that a rejected edit leaves the previous file exactly as it was.
 */

const DECLARED = { name: 'model-bump-check', member: 'wakee@harness', prompt: 'check the model catalog' } as const

let root: string
let path: string
const warnings: string[] = []
const warn = (message: string): void => { warnings.push(message) }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'routine-store-'))
  path = join(root, 'routines', 'routines.json')
  warnings.length = 0
})

afterEach(() => {
  warnings.length = 0
})

describe('routine store reads', () => {
  it('treats an absent store as the normal first-run state', () => {
    expect(readRoutineStore(path, warn)).toEqual([])
    expect(warnings).toEqual([])
  })

  it('returns the declarations in file order', () => {
    mkdirFor(path)
    writeFileSync(path, JSON.stringify({
      version: 1,
      routines: [
        { ...DECLARED, cron: '0 * * * *' },
        { ...DECLARED, name: 'nightly-sweep', cron: '0 9 * * 1' },
      ],
    }))
    const read = readRoutineStore(path, warn)
    expect(read.map(entry => entry.name)).toEqual(['model-bump-check', 'nightly-sweep'])
    expect(warnings).toEqual([])
  })

  it('warns once and runs nothing when the file is not JSON', () => {
    mkdirFor(path)
    writeFileSync(path, 'not json at all')
    expect(readRoutineStore(path, warn)).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unusable')
  })

  it('warns once and runs nothing when a declaration cannot run', () => {
    mkdirFor(path)
    writeFileSync(path, JSON.stringify({ version: 1, routines: [{ ...DECLARED, cron: '0 9 * *' }] }))
    expect(readRoutineStore(path, warn)).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unusable')
  })

  it('refuses a stored declaration that still carries the retired interval trigger', () => {
    // A store an older build wrote: the read refuses the entry by name rather
    // than running a routine whose schedule nobody can state any more.
    mkdirFor(path)
    writeFileSync(path, JSON.stringify({ version: 1, routines: [{ ...DECLARED, everySeconds: 60 }] }))
    expect(readRoutineStore(path, warn)).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no longer supported')
  })

  it('refuses a file without a routines list', () => {
    mkdirFor(path)
    writeFileSync(path, JSON.stringify({ version: 1 }))
    expect(readRoutineStore(path, warn)).toEqual([])
    expect(warnings[0]).toContain('unusable')
  })
})

describe('routine store writes', () => {
  it('creates the directory, round-trips, and leaves no temporary file', () => {
    const routines: readonly RoutineConfig[] = [{ ...DECLARED, cron: '*/10 * * * *' }]
    writeRoutineStore(path, routines)
    expect(readRoutineStore(path, warn)).toEqual(routines)
    expect(existsSync(routineStoreTemporaryPath(path))).toBe(false)
  })

  it('replaces earlier content without leaving half a file', () => {
    writeRoutineStore(path, [{ ...DECLARED, cron: '*/10 * * * *' }])
    writeRoutineStore(path, [{ ...DECLARED, name: 'nightly-sweep', cron: '0 0 * * *' }])
    const written = JSON.parse(readFileSync(path, 'utf8')) as { version: number; routines: readonly RoutineConfig[] }
    expect(written.version).toBe(1)
    expect(written.routines.map(entry => entry.name)).toEqual(['nightly-sweep'])
  })

  it('rejects a declaration the Host cannot run and leaves the file intact', () => {
    writeRoutineStore(path, [{ ...DECLARED, cron: '*/10 * * * *' }])
    const before = readFileSync(path, 'utf8')
    expect(() => writeRoutineStore(path, [{ ...DECLARED, cron: 'nope' }])).toThrow(/cron/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('routine store saved entries', () => {
  const HUMAN = { kind: 'human', memberId: AGENT_TEAM_HUMAN_MEMBER_ID, handle: 'human' } as const
  const SCOUT = { kind: 'member', memberId: 'member:scout' as AgentTeamMemberId, handle: 'scout' } as const
  const SAVED_AT = '2026-09-25T09:00:00.000Z'
  const LATER = '2026-09-25T10:00:00.000Z'
  const ROUTINE = { name: 'standup', member: 'scout', prompt: 'report your progress', cron: '0 * * * *' } as const

  it('records who saved a routine and when, and keeps that creation on a later save', () => {
    const first = saveStoredRoutine(path, ROUTINE, HUMAN, SAVED_AT)
    expect(first.created).toBe(true)
    expect(first.routine).toMatchObject({ name: 'standup', createdBy: HUMAN, createdAt: SAVED_AT })
    expect(first.routine.updatedBy).toBeUndefined()

    const second = saveStoredRoutine(path, { ...ROUTINE, prompt: 'report your progress, briefly' }, SCOUT, LATER)
    expect(second.created).toBe(false)
    // The Member replaced the routine; the Human who scheduled it is still on it.
    expect(second.routine).toMatchObject({ prompt: 'report your progress, briefly', createdBy: HUMAN, createdAt: SAVED_AT, updatedBy: SCOUT, updatedAt: LATER })
    expect(readRoutineStore(path, warn)).toEqual([second.routine])
    expect(warnings).toEqual([])
  })

  it('keeps the entry where it was when a save replaces it', () => {
    saveStoredRoutine(path, ROUTINE, HUMAN, SAVED_AT)
    saveStoredRoutine(path, { ...ROUTINE, name: 'nightly-sweep' }, HUMAN, SAVED_AT)
    saveStoredRoutine(path, { ...ROUTINE, cron: '*/10 * * * *' }, SCOUT, LATER)
    expect(readRoutineStore(path, warn).map(entry => entry.name)).toEqual(['standup', 'nightly-sweep'])
  })

  it('never takes attribution from the caller', () => {
    const forged = { ...ROUTINE, createdBy: SCOUT, createdAt: LATER, updatedBy: SCOUT, updatedAt: LATER } as unknown as RoutineConfig
    const saved = saveStoredRoutine(path, forged, HUMAN, SAVED_AT)
    expect(saved.routine).toMatchObject({ createdBy: HUMAN, createdAt: SAVED_AT })
    expect(saved.routine.updatedBy).toBeUndefined()
  })

  it('deletes by name and reports a name the store does not hold', () => {
    saveStoredRoutine(path, ROUTINE, HUMAN, SAVED_AT)
    saveStoredRoutine(path, { ...ROUTINE, name: 'nightly-sweep' }, HUMAN, SAVED_AT)
    expect(deleteStoredRoutine(path, 'standup')).toEqual({ removed: true })
    expect(readRoutineStore(path, warn).map(entry => entry.name)).toEqual(['nightly-sweep'])
    expect(deleteStoredRoutine(path, 'standup')).toEqual({ removed: false })
    expect(deleteStoredRoutine(path, 'never-existed')).toEqual({ removed: false })
  })

  it('refuses a declaration it cannot run and leaves every stored routine untouched', () => {
    saveStoredRoutine(path, ROUTINE, HUMAN, SAVED_AT)
    const before = readFileSync(path, 'utf8')
    expect(() => saveStoredRoutine(path, { ...ROUTINE, cron: '' }, HUMAN, LATER)).toThrow(/cron/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('refuses to write over a store it cannot read', () => {
    mkdirFor(path)
    writeFileSync(path, 'not json at all')
    expect(() => saveStoredRoutine(path, ROUTINE, HUMAN, SAVED_AT)).toThrow(/is unusable/)
    expect(() => deleteStoredRoutine(path, 'standup')).toThrow(/is unusable/)
    expect(readFileSync(path, 'utf8')).toBe('not json at all')
  })

  it('treats a store an earlier version wrote as an unattributed routine that still runs', () => {
    writeRoutineStore(path, [{ ...DECLARED, cron: '*/10 * * * *' }])
    expect(readStoredRoutines(path)).toEqual([{ ...DECLARED, cron: '*/10 * * * *' }])
    const saved = saveStoredRoutine(path, { ...DECLARED, cron: '*/5 * * * *' }, HUMAN, SAVED_AT)
    // The entry that was already there recorded nobody, and this save does not
    // claim to have created it: it records itself as the change.
    expect(saved.routine).toMatchObject({ cron: '*/5 * * * *', updatedBy: HUMAN, updatedAt: SAVED_AT })
    expect(saved.routine.createdBy).toBeUndefined()
  })
})

describe('routine store merge', () => {  it('lets the store own a name it declares and keeps config-only routines', () => {
    const merged = mergeRoutines(
      [{ ...DECLARED, cron: '*/10 * * * *' }],
      [{ ...DECLARED, cron: '0 * * * *' }, { ...DECLARED, name: 'nightly-sweep', cron: '0 0 * * *' }],
    )
    expect(merged.map(routine => routine.name)).toEqual(['model-bump-check', 'nightly-sweep'])
    // The store's expression wins: one name, one armed routine, not two.
    expect(merged[0]?.cron).toBe('*/10 * * * *')
    expect(merged[1]?.cron).toBe('0 0 * * *')
  })

  it('reports a broken declaration as a broken declaration', () => {
    expect(() => mergeRoutines([], [{ ...DECLARED, cron: '0 9 * *' }])).toThrow(/routines\[0\]\.cron/)
    expect(() => mergeRoutines([], [{ ...DECLARED, at: '2026-09-25T09:00:00+09:00' }])).toThrow(/routines\[0\]\.at is no longer supported/)
  })
})

describe('routine store watch', () => {
  it('reports a write to the store file', async () => {
    let calls = 0
    const dispose = watchRoutineStore(path, () => { calls += 1 }, warn)
    try {
      await settle()
      writeRoutineStore(path, [{ ...DECLARED, cron: '*/10 * * * *' }])
      expect(await waitFor(() => calls > 0)).toBe(true)
      expect(warnings).toEqual([])
    } finally {
      dispose()
    }
  })

  it('stops reporting after disposal', async () => {
    let calls = 0
    const dispose = watchRoutineStore(path, () => { calls += 1 }, warn)
    await settle()
    dispose()
    writeRoutineStore(path, [{ ...DECLARED, cron: '*/10 * * * *' }])
    await sleep(300)
    expect(calls).toBe(0)
  })
})

function mkdirFor(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Let the watcher attach before the first write, so the event cannot be missed. */
async function settle(): Promise<void> {
  await sleep(50)
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}
