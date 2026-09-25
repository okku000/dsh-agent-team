import { describe, expect, it } from 'vitest'
import {
  isRepeatingRoutine,
  nextRoutineOccurrence,
  normalizeRoutines,
  routineBody,
  routineSummary,
  routineTarget,
  type Routine,
} from '../src/routine-schedule.ts'

/** One routine declaration: the default target and instruction, plus overrides. */
const ROUTINE = {
  name: 'model-bump-check',
  member: 'wakee@harness',
  prompt: 'check the model catalog',
  cron: '*/15 * * * *',
} as const

/** The zone and instant validation evaluates in, so a test never reads the clock. */
const AT = Date.parse('2026-09-25T00:00:00Z')
const FIXED = { timeZone: 'UTC', nowMs: AT } as const

/** One validated routine, so the math can be exercised without the config layer. */
function routine(overrides: Partial<Routine> = {}): Routine {
  return { name: ROUTINE.name, member: ROUTINE.member, prompt: ROUTINE.prompt, once: false, cron: ROUTINE.cron, ...overrides }
}

describe('routine configuration', () => {
  it('accepts one cron trigger, and normalizes text fields', () => {
    const [quarterly, weekly] = normalizeRoutines([
      { ...ROUTINE, member: '  wakee@harness  ', prompt: '  go  ' },
      { ...ROUTINE, name: 'one-shot', cron: '  30  9  *  *  1 ', once: true, summary: '  nightly  ' },
    ], 'routines', FIXED)
    expect(quarterly).toEqual({ name: 'model-bump-check', member: 'wakee@harness', prompt: 'go', once: false, cron: '*/15 * * * *' })
    expect(weekly).toEqual({ name: 'one-shot', member: 'wakee@harness', prompt: 'check the model catalog', once: true, cron: '30 9 * * 1', summary: 'nightly' })
  })

  it('carries only the fields a wake needs, so a routine has exactly one shape', () => {
    const [declared] = normalizeRoutines([{ ...ROUTINE, channel: 'channel:someone-elses', body: 'ignored' } as never], 'routines', FIXED)
    expect(declared).toEqual({ name: 'model-bump-check', member: 'wakee@harness', prompt: 'check the model catalog', once: false, cron: '*/15 * * * *' })
  })

  it('reads an absent or empty list as no routines', () => {
    expect(normalizeRoutines(undefined)).toEqual([])
    expect(normalizeRoutines([])).toEqual([])
  })

  it('refuses a config that cannot run, naming the entry', () => {
    expect(() => normalizeRoutines({ routines: [] })).toThrow(/must be a list/)
    expect(() => normalizeRoutines(['nope'])).toThrow(/routines\[0\] must be a mapping/)
    expect(() => normalizeRoutines([{ ...ROUTINE, name: 'bad name' }], 'routines', FIXED)).toThrow(/.name must match/)
    expect(() => normalizeRoutines([{ ...ROUTINE, name: '-leading' }], 'routines', FIXED)).toThrow(/.name must match/)
    expect(() => normalizeRoutines([{ ...ROUTINE, member: '   ' }], 'routines', FIXED)).toThrow(/.member must be a Member handle or id/)
    expect(() => normalizeRoutines([{ ...ROUTINE, prompt: '' }], 'routines', FIXED)).toThrow(/.prompt must be a non-empty instruction/)
    expect(() => normalizeRoutines([{ ...ROUTINE, summary: ' ' }], 'routines', FIXED)).toThrow(/.summary must be a non-empty string/)
    expect(() => normalizeRoutines([{ ...ROUTINE, once: 'yes' }], 'routines', FIXED)).toThrow(/.once must be a boolean/)
    expect(() => normalizeRoutines([{ ...ROUTINE }, { ...ROUTINE }], 'routines', FIXED)).toThrow(/declared twice/)
    // A cron field is validated here, and the rejection names the row's own field.
    expect(() => normalizeRoutines([{ ...ROUTINE, cron: '0 9 * *' }], 'routines', FIXED)).toThrow(/routines\[0\]\.cron '0 9 \* \*' must have five fields/)
    expect(() => normalizeRoutines([{ name: 'x', member: 'y', prompt: 'z' } as never], 'routines', FIXED)).toThrow(/routines\[0\]\.cron must be a non-empty string/)
  })

  it('refuses the interval and instant triggers it used to accept, naming the replacement', () => {
    for (const legacy of [{ everySeconds: 3600 }, { at: '2026-09-25T09:00:00Z' }, { anchorAt: '2026-09-25T09:00:00Z' }]) {
      const entry = { ...ROUTINE, ...legacy }
      expect(() => normalizeRoutines([entry], 'routines', FIXED)).toThrow(/is no longer supported: a routine's trigger is one five-field cron expression/)
      // The field that has to go is the one named, not whichever the loop reaches first.
      const [field] = Object.keys(legacy)
      expect(() => normalizeRoutines([entry], 'routines', FIXED)).toThrow(new RegExp(`routines\\[0\\]\\.${field} is no longer supported`))
    }
  })

  it('refuses an expression that can never fire, because silence is the one failure nobody sees', () => {
    expect(() => normalizeRoutines([{ ...ROUTINE, cron: '0 0 30 2 *' }], 'routines', FIXED))
      .toThrow(/routines\[0\]\.cron '0 0 30 2 \*' never fires within five years in zone 'UTC'/)
    // The leap-day expression is the near miss: it fires, just rarely.
    expect(normalizeRoutines([{ ...ROUTINE, cron: '0 0 29 2 *' }], 'routines', FIXED)[0]?.cron).toBe('0 0 29 2 *')
  })

  it('addresses a target by branded id or by handle', () => {
    expect(routineTarget('member:5b631fa5-cde1-4549-9dbc-2612779b1b84')).toEqual({ memberId: 'member:5b631fa5-cde1-4549-9dbc-2612779b1b84' })
    expect(routineTarget('wakee@harness')).toEqual({ handle: 'wakee@harness' })
  })
})

describe('routine occurrences', () => {
  const start = Date.parse('2026-09-25T00:00:00Z')

  it('reads the next fire off the expression, in the zone it is given', () => {
    expect(nextRoutineOccurrence(routine(), start, 'UTC')).toBe(Date.parse('2026-09-25T00:15:00Z'))
    expect(nextRoutineOccurrence(routine({ cron: '30 9 * * 1' }), start, 'UTC')).toBe(Date.parse('2026-09-28T09:30:00Z'))
    // The same wall-clock reading is a different instant in another zone.
    expect(nextRoutineOccurrence(routine({ cron: '30 9 * * *' }), start, 'Asia/Tokyo')).toBe(Date.parse('2026-09-25T00:30:00Z'))
  })

  it('lands on the same phase however long the Host was down', () => {
    const every = routine({ cron: '0 * * * *' })
    const first = nextRoutineOccurrence(every, start, 'UTC')!
    // A Host that missed hours of fires still arms the next top of the hour,
    // because the expression is the phase — nothing drifts with the downtime.
    const later = Date.parse('2026-09-25T05:17:00Z')
    expect(first).toBe(Date.parse('2026-09-25T01:00:00Z'))
    expect(nextRoutineOccurrence(every, later, 'UTC')).toBe(Date.parse('2026-09-25T06:00:00Z'))
  })

  it('fires a `once` routine at its next occurrence, and then no more', () => {
    const single = routine({ cron: '30 9 * * *', once: true })
    expect(nextRoutineOccurrence(single, start, 'UTC')).toBe(Date.parse('2026-09-25T09:30:00Z'))
    expect(isRepeatingRoutine(single)).toBe(false)
  })

  it('repeats an expression unless it is declared once', () => {
    expect(isRepeatingRoutine(routine())).toBe(true)
    expect(isRepeatingRoutine(routine({ once: true }))).toBe(false)
  })
})

describe('routine framing', () => {
  it('states the unattended origin, the Team instant, the expression, and the instruction', () => {
    const firedAt = Date.parse('2026-09-25T04:00:00Z')
    const body = routineBody(routine(), firedAt)
    expect(body.split('\n')[0]).toBe("[ROUTINE FIRE] model-bump-check — fired 2026-09-25T12:00:00+08:00 (cron '*/15 * * * *')")
    expect(body).toMatch(/unattended scheduled routine started by the Agent Team Host/)
    expect(body).toMatch(/nobody is waiting in this conversation for a reply/)
    expect(body.endsWith('\ncheck the model catalog')).toBe(true)
  })

  it('defaults the notice summary to the routine name', () => {
    expect(routineSummary(routine())).toBe('Scheduled routine fired: model-bump-check')
    expect(routineSummary(routine({ summary: 'catalog check' }))).toBe('catalog check')
  })
})
