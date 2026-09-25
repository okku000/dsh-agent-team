import { describe, expect, it } from 'vitest'
import {
  isRepeatingRoutine,
  nextRoutineOccurrence,
  normalizeRoutines,
  routineBody,
  routineSummary,
  routineTarget,
  ROUTINE_MIN_INTERVAL_SECONDS,
  type Routine,
} from '../src/routine-schedule.ts'

/** One routine declaration: the default target and instruction, plus overrides. */
const ROUTINE = {
  name: 'model-bump-check',
  member: 'wakee@harness',
  prompt: 'check the model catalog',
} as const

/** One validated routine, so the math can be exercised without the config layer. */
function routine(overrides: Partial<Routine> = {}): Routine {
  return { name: ROUTINE.name, member: ROUTINE.member, prompt: ROUTINE.prompt, once: false, ...overrides }
}

describe('routine configuration', () => {
  it('accepts one trigger, and normalizes text fields', () => {
    const [interval, instant] = normalizeRoutines([
      { ...ROUTINE, member: '  wakee@harness  ', prompt: '  go  ', everySeconds: 60 },
      { ...ROUTINE, name: 'one-shot', at: '2026-09-25T09:00:00+09:00', summary: '  nightly  ' },
    ])
    expect(interval).toEqual({ name: 'model-bump-check', member: 'wakee@harness', prompt: 'go', once: false, everySeconds: 60 })
    expect(interval?.at).toBeUndefined()
    expect(instant?.at).toBe(Date.parse('2026-09-25T09:00:00+09:00'))
    expect(instant).toMatchObject({ summary: 'nightly' })
  })

  it('carries only the fields a wake needs, so a routine has exactly one shape', () => {
    const [declared] = normalizeRoutines([{ ...ROUTINE, everySeconds: 60, channel: 'channel:someone-elses', body: 'ignored' } as never])
    expect(declared).toEqual({ name: 'model-bump-check', member: 'wakee@harness', prompt: 'check the model catalog', once: false, everySeconds: 60 })
  })

  it('reads an absent or empty list as no routines', () => {
    expect(normalizeRoutines(undefined)).toEqual([])
    expect(normalizeRoutines([])).toEqual([])
  })

  it('refuses a config that cannot run, naming the entry', () => {
    expect(() => normalizeRoutines({ routines: [] })).toThrow(/must be a list/)
    expect(() => normalizeRoutines(['nope'])).toThrow(/routines\[0\] must be a mapping/)
    expect(() => normalizeRoutines([{ ...ROUTINE }])).toThrow(/needs exactly one trigger/)
    expect(() => normalizeRoutines([{ ...ROUTINE, everySeconds: 60, at: '2026-09-25T09:00:00Z' }])).toThrow(/needs exactly one trigger/)
    expect(() => normalizeRoutines([{ ...ROUTINE, everySeconds: ROUTINE_MIN_INTERVAL_SECONDS - 1 }])).toThrow(/integer >= 60/)
    expect(() => normalizeRoutines([{ ...ROUTINE, everySeconds: 90.5 }])).toThrow(/integer >= 60/)
    expect(() => normalizeRoutines([{ ...ROUTINE, name: 'bad name' }])).toThrow(/.name must match/)
    expect(() => normalizeRoutines([{ ...ROUTINE, name: '-leading' }])).toThrow(/.name must match/)
    expect(() => normalizeRoutines([{ ...ROUTINE, member: '   ' }])).toThrow(/.member must be a Member handle or id/)
    expect(() => normalizeRoutines([{ ...ROUTINE, prompt: '' }])).toThrow(/.prompt must be a non-empty instruction/)
    expect(() => normalizeRoutines([{ ...ROUTINE, summary: ' ' }])).toThrow(/.summary must be a non-empty string/)
    expect(() => normalizeRoutines([{ ...ROUTINE, once: 'yes' }])).toThrow(/.once must be a boolean/)
    // A bare local time is refused: an instant nobody can place is worse than a loud failure.
    expect(() => normalizeRoutines([{ ...ROUTINE, at: '2026-09-25T09:00:00' }])).toThrow(/.at must be RFC 3339/)
    expect(() => normalizeRoutines([{ ...ROUTINE, everySeconds: 60, anchorAt: 'tomorrow' }])).toThrow(/.anchorAt must be RFC 3339/)
    expect(() => normalizeRoutines([{ ...ROUTINE, everySeconds: 60 }, { ...ROUTINE, everySeconds: 60 }])).toThrow(/declared twice/)
  })

  it('addresses a target by branded id or by handle', () => {
    expect(routineTarget('member:5b631fa5-cde1-4549-9dbc-2612779b1b84')).toEqual({ memberId: 'member:5b631fa5-cde1-4549-9dbc-2612779b1b84' })
    expect(routineTarget('wakee@harness')).toEqual({ handle: 'wakee@harness' })
  })
})

describe('routine occurrences', () => {
  const start = Date.parse('2026-09-25T00:00:00Z')

  it('arms an unanchored interval one interval after the first arming', () => {
    expect(nextRoutineOccurrence(routine({ everySeconds: 60 }), start)).toBe(start + 60_000)
  })

  it('keeps a configured phase, and the same phase after a restart', () => {
    const anchorAt = start - 30_000
    const anchored = routine({ everySeconds: 3600, anchorAt })
    expect(nextRoutineOccurrence(anchored, start)).toBe(start + 3_570_000)
    // A restart hours later re-derives the same grid instead of drifting by the downtime.
    const later = start + 5 * 3600_000 + 1234
    const expected = anchorAt + Math.floor((later - anchorAt) / 3600_000) * 3600_000 + 3600_000
    expect(nextRoutineOccurrence(anchored, later)).toBe(expected)
  })

  it('waits for a future anchor', () => {
    const anchorAt = start + 90_000
    expect(nextRoutineOccurrence(routine({ everySeconds: 60, anchorAt }), start)).toBe(anchorAt)
  })

  it('fires a one-shot once, and reports a spent instant as unarmable', () => {
    const future = routine({ at: start + 1_000 })
    expect(nextRoutineOccurrence(future, start)).toBe(start + 1_000)
    expect(nextRoutineOccurrence(future, start + 999)).toBe(start + 1_000)
    // Strictly after: at the instant it is due there is no *next* occurrence left.
    expect(nextRoutineOccurrence(future, start + 1_000)).toBeUndefined()
    expect(nextRoutineOccurrence(future, start + 1_001)).toBeUndefined()
    expect(nextRoutineOccurrence(routine({ at: start, once: true }), start)).toBeUndefined()
  })

  it('repeats an interval unless it is declared once', () => {
    expect(isRepeatingRoutine(routine({ everySeconds: 60 }))).toBe(true)
    expect(isRepeatingRoutine(routine({ everySeconds: 60, once: true }))).toBe(false)
    expect(isRepeatingRoutine(routine({ at: start }))).toBe(false)
  })
})

describe('routine framing', () => {
  it('states the unattended origin, the Team instant, and the instruction', () => {
    const firedAt = Date.parse('2026-09-25T04:00:00Z')
    const body = routineBody(routine(), firedAt)
    expect(body.split('\n')[0]).toBe('[ROUTINE FIRE] model-bump-check — fired 2026-09-25T12:00:00+08:00')
    expect(body).toMatch(/unattended scheduled routine started by the Agent Team Host/)
    expect(body).toMatch(/nobody is waiting in this conversation for a reply/)
    expect(body.endsWith('\ncheck the model catalog')).toBe(true)
  })

  it('defaults the notice summary to the routine name', () => {
    expect(routineSummary(routine())).toBe('Scheduled routine fired: model-bump-check')
    expect(routineSummary(routine({ summary: 'catalog check' }))).toBe('catalog check')
  })
})
