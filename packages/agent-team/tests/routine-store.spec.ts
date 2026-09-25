import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeRoutines, readRoutineStore, routineStoreTemporaryPath, watchRoutineStore, writeRoutineStore } from '../src/routine-store.ts'
import type { RoutineConfig } from '../src/routine-schedule.ts'

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
        { ...DECLARED, everySeconds: 3600 },
        { ...DECLARED, name: 'nightly-sweep', at: '2026-09-25T09:00:00+09:00' },
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
    writeFileSync(path, JSON.stringify({ version: 1, routines: [{ ...DECLARED, everySeconds: 60, at: '2026-09-25T09:00:00+09:00' }] }))
    expect(readRoutineStore(path, warn)).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unusable')
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
    const routines: readonly RoutineConfig[] = [{ ...DECLARED, everySeconds: 600 }]
    writeRoutineStore(path, routines)
    expect(readRoutineStore(path, warn)).toEqual(routines)
    expect(existsSync(routineStoreTemporaryPath(path))).toBe(false)
  })

  it('replaces earlier content without leaving half a file', () => {
    writeRoutineStore(path, [{ ...DECLARED, everySeconds: 600 }])
    writeRoutineStore(path, [{ ...DECLARED, name: 'nightly-sweep', everySeconds: 86400 }])
    const written = JSON.parse(readFileSync(path, 'utf8')) as { version: number; routines: readonly RoutineConfig[] }
    expect(written.version).toBe(1)
    expect(written.routines.map(entry => entry.name)).toEqual(['nightly-sweep'])
  })

  it('rejects a declaration the Host cannot run and leaves the file intact', () => {
    writeRoutineStore(path, [{ ...DECLARED, everySeconds: 600 }])
    const before = readFileSync(path, 'utf8')
    expect(() => writeRoutineStore(path, [{ ...DECLARED, everySeconds: 1 }])).toThrow(/everySeconds/)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('routine store merge', () => {
  it('lets the store own a name it declares and keeps config-only routines', () => {
    const merged = mergeRoutines(
      [{ ...DECLARED, everySeconds: 600 }],
      [{ ...DECLARED, everySeconds: 3600 }, { ...DECLARED, name: 'nightly-sweep', everySeconds: 86400 }],
    )
    expect(merged.map(routine => routine.name)).toEqual(['model-bump-check', 'nightly-sweep'])
    // The store's interval wins: one name, one armed routine, not two.
    expect(merged[0]?.everySeconds).toBe(600)
    expect(merged[1]?.everySeconds).toBe(86400)
  })

  it('reports a broken declaration as a broken declaration', () => {
    expect(() => mergeRoutines([], [{ ...DECLARED, everySeconds: 60, at: '2026-09-25T09:00:00+09:00' }])).toThrow(/routines\[0\]/)
  })
})

describe('routine store watch', () => {
  it('reports a write to the store file', async () => {
    let calls = 0
    const dispose = watchRoutineStore(path, () => { calls += 1 }, warn)
    try {
      await settle()
      writeRoutineStore(path, [{ ...DECLARED, everySeconds: 600 }])
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
    writeRoutineStore(path, [{ ...DECLARED, everySeconds: 600 }])
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
