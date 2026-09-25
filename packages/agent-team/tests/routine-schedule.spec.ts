import { describe, expect, it } from 'vitest'
import {
  isRepeatingRoutine,
  nextRoutineOccurrence,
  normalizeRoutines,
  routineBody,
  routinePostBody,
  routineSummary,
  routineTarget,
  ROUTINE_MIN_INTERVAL_SECONDS,
  type WakeAction,
  type WakeRoutine,
} from '../src/routine-schedule.ts'

/** One wake declaration: the default target and instruction, plus overrides. */
const ROUTINE = {
  name: 'model-bump-check',
  member: 'wakee@harness',
  prompt: 'check the model catalog',
} as const

/** One post declaration: the default Channel and body, plus overrides. */
const POST = {
  name: 'standup',
  kind: 'post',
  workspaceId: 'workspace:6f0d0f7c-4f4b-4a5e-8a1e-1f2b3c4d5e6f',
  channel: 'channel:2b8c9d0e-1a2b-4c3d-9e4f-5a6b7c8d9e0f',
  mentions: ['wakee@harness'],
  body: 'report your progress',
} as const

/** One validated wake action, so a routine can be built without the config layer. */
function wakeAction(overrides: Partial<WakeAction> = {}): WakeAction {
  return { kind: 'wake', member: ROUTINE.member, prompt: ROUTINE.prompt, ...overrides }
}

/** One validated routine, so the math can be exercised without the config layer. */
function routine(overrides: Partial<WakeRoutine> = {}): WakeRoutine {
  return { name: ROUTINE.name, action: wakeAction(), once: false, ...overrides }
}

describe('routine configuration', () => {
  it('accepts one trigger, and normalizes text fields', () => {
    const [interval, instant] = normalizeRoutines([
      { ...ROUTINE, member: '  wakee@harness  ', prompt: '  go  ', everySeconds: 60 },
      { ...ROUTINE, name: 'one-shot', at: '2026-09-25T09:00:00+09:00', summary: '  nightly  ' },
    ])
    expect(interval).toMatchObject({ action: { kind: 'wake', member: 'wakee@harness', prompt: 'go' }, everySeconds: 60, once: false })
    expect(interval?.at).toBeUndefined()
    expect(instant?.at).toBe(Date.parse('2026-09-25T09:00:00+09:00'))
    expect(instant?.action).toMatchObject({ summary: 'nightly' })
  })

  it('defaults an undeclared action to a wake, so a pre-post declaration keeps running', () => {
    const [declared] = normalizeRoutines([{ ...ROUTINE, everySeconds: 60 }])
    expect(declared?.action).toEqual({ kind: 'wake', member: 'wakee@harness', prompt: 'check the model catalog' })
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
    expect(() => normalizeRoutines([{ ...ROUTINE, kind: 'shout', everySeconds: 60 }])).toThrow(/.kind must be 'wake' or 'post'/)
  })

  it('normalizes a post: trims the refs, strips a leading @ off each mention, and de-duplicates', () => {
    const [post] = normalizeRoutines([{
      ...POST,
      workspaceId: `  ${POST.workspaceId}  `,
      channel: `  ${POST.channel}  `,
      mentions: ['@wakee@harness', 'wakee@harness', '  other@harness  '],
      body: '  report your progress  ',
      everySeconds: 60,
    }])
    expect(post?.action).toEqual({
      kind: 'post',
      workspaceId: POST.workspaceId,
      channel: POST.channel,
      mentions: ['wakee@harness', 'other@harness'],
      body: 'report your progress',
      asTask: false,
    })
  })

  it('refuses a post that cannot run, naming the entry', () => {
    expect(() => normalizeRoutines([{ ...POST }])).toThrow(/needs exactly one trigger/)
    expect(() => normalizeRoutines([{ ...POST, workspaceId: '  ', everySeconds: 60 }])).toThrow(/.workspaceId must name the Workspace/)
    expect(() => normalizeRoutines([{ ...POST, channel: '', everySeconds: 60 }])).toThrow(/.channel must name a Channel/)
    expect(() => normalizeRoutines([{ ...POST, body: '   ', everySeconds: 60 }])).toThrow(/.body must be a non-empty Message body/)
    expect(() => normalizeRoutines([{ ...POST, asTask: 'yes', everySeconds: 60 }])).toThrow(/.asTask must be a boolean/)
    expect(() => normalizeRoutines([{ ...POST, mentions: 'wakee@harness', everySeconds: 60 }])).toThrow(/.mentions must be a list/)
    expect(() => normalizeRoutines([{ ...POST, mentions: [' '], everySeconds: 60 }])).toThrow(/.mentions must hold non-empty Member handles/)
  })

  it('carries the post fields only on a post, so an undeclared action stays a wake', () => {
    const [wake] = normalizeRoutines([{ ...ROUTINE, channel: POST.channel, body: 'ignored', everySeconds: 60 }])
    expect(wake?.action).toEqual({ kind: 'wake', member: 'wakee@harness', prompt: 'check the model catalog' })
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
    expect(routineSummary(routine({ action: wakeAction({ summary: 'catalog check' }) }))).toBe('catalog check')
  })
})

describe('routine post body', () => {
  /** One validated post routine, so the body can be built without the config layer. */
  function post(mentions: readonly string[], body: string) {
    return { name: 'standup', action: { kind: 'post', workspaceId: POST.workspaceId, channel: POST.channel, mentions, body, asTask: false } as const }
  }

  it('renders every configured mention the body does not already carry', () => {
    expect(routinePostBody(post(['wakee@harness', 'other@harness'], 'report your progress'))).toBe('@wakee@harness @other@harness report your progress')
  })

  it('leaves a handle the body already carries alone, so the chip reads once', () => {
    expect(routinePostBody(post(['wakee@harness'], '@wakee@harness report your progress'))).toBe('@wakee@harness report your progress')
    // A body that names a handle the config does not mention is posted as written.
    expect(routinePostBody(post([], 'ping @someone@harness'))).toBe('ping @someone@harness')
  })

  it('posts a mention-free body verbatim', () => {
    expect(routinePostBody(post([], 'the nightly build is green'))).toBe('the nightly build is green')
  })
})
