import { describe, expect, it } from 'vitest'
import {
  CRON_SEARCH_HORIZON_MS,
  cronTimeZone,
  nextCronOccurrence,
  nextCronOccurrences,
  parseCronExpression,
} from '../src/cron-expression.ts'

/** Parse, or fail the test with the thrown message in the assertion output. */
function parse(text: string) {
  return parseCronExpression(text)
}

/** The instants one expression fires, as ISO strings, for readable assertions. */
function fires(text: string, fromIso: string, count: number, timeZone = 'UTC'): string[] {
  const from = Date.parse(fromIso)
  return nextCronOccurrences(parse(text), from, count, timeZone).map(instant => new Date(instant).toISOString())
}

/** The next instant one expression fires, as an ISO string, or undefined. */
function next(text: string, fromIso: string, timeZone = 'UTC'): string | undefined {
  const instant = nextCronOccurrence(parse(text), Date.parse(fromIso), timeZone)
  return instant === undefined ? undefined : new Date(instant).toISOString()
}

describe('cron grammar', () => {
  it('reads the five fields in order, and marks only a literal star unrestricted', () => {
    const every = parse('*/15 9-17 1,15 * *')
    expect(every.source).toBe('*/15 9-17 1,15 * *')
    expect(every.minute.values).toEqual([0, 15, 30, 45])
    expect(every.hour.values).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(every.dayOfMonth.values).toEqual([1, 15])
    expect(every.month.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(every.dayOfWeek.values).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([every.minute.restricted, every.hour.restricted, every.dayOfMonth.restricted, every.month.restricted, every.dayOfWeek.restricted])
      .toEqual([true, true, true, false, false])
    expect(parse('* * * * *').minute.restricted).toBe(false)
    // A step over everything still constrains the field, which is what the day rule reads.
    expect(parse('0 0 */1 * *').dayOfMonth.restricted).toBe(true)
  })

  it('accepts names for month and weekday, by prefix and in ranges', () => {
    expect(parse('0 9 * * mon-fri').dayOfWeek.values).toEqual([1, 2, 3, 4, 5])
    expect(parse('0 9 * * MON-FRI').dayOfWeek.values).toEqual([1, 2, 3, 4, 5])
    expect(parse('0 0 1 jan *').month.values).toEqual([1])
    expect(parse('0 0 1 ja *').month.values).toEqual([1])
    expect(parse('0 0 1 january *').month.values).toEqual([1])
    expect(parse('0 0 1 JAN,JUL *').month.values).toEqual([1, 7])
    expect(parse('0 0 * * sun').dayOfWeek.values).toEqual([0])
  })

  it('folds day-of-week 7 onto Sunday, and reads `a/n` as `a` to the end of the field', () => {
    expect(parse('0 0 * * 7').dayOfWeek.values).toEqual(parse('0 0 * * 0').dayOfWeek.values)
    expect(parse('0 0 * * 0-7').dayOfWeek.values).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parse('10/20 * * * *').minute.values).toEqual([10, 30, 50])
    expect(parse('0 0 * * 5/2').dayOfWeek.values).toEqual([0, 5])
    expect(parse('5-10/2 * * * *').minute.values).toEqual([5, 7, 9])
  })

  it('normalizes whitespace and refuses anything but the five-field form', () => {
    expect(parse('  0   9  *  *  * ').source).toBe('0 9 * * *')
    expect(() => parseCronExpression('')).toThrow(/must be a non-empty string/)
    expect(() => parseCronExpression(undefined)).toThrow(/must be a non-empty string/)
    expect(() => parse('@daily')).toThrow(/unsupported macro/)
    expect(() => parse('0 9 * *')).toThrow(/must have five fields .*got 4/)
    expect(() => parse('0 9 * * * *')).toThrow(/must have five fields .*got 6/)
    expect(() => parse('30 2 * * * *')).toThrow(/got 6/)
  })

  it('names the offending field and item, so a wrong expression is fixable', () => {
    expect(() => parse('60 * * * *')).toThrow(/minute '60' is out of range 0-59/)
    expect(() => parse('* 24 * * *')).toThrow(/hour '24' is out of range 0-23/)
    expect(() => parse('* * 0 * *')).toThrow(/day-of-month '0' is out of range 1-31/)
    expect(() => parse('* * 32 * *')).toThrow(/day-of-month '32' is out of range 1-31/)
    expect(() => parse('* * * 13 *')).toThrow(/month '13' is out of range 1-12/)
    expect(() => parse('* * * * 8')).toThrow(/day-of-week '8' is out of range 0-7/)
    expect(() => parse('10-5 * * * *')).toThrow(/minute '10-5' is not a valid range: 10 is greater than 5/)
    expect(() => parse('0 9 * * fri-mon')).toThrow(/day-of-week 'fri-mon' is not a valid range: fri is greater than mon/)
    expect(() => parse('*/0 * * * *')).toThrow(/minute '\*\/0' must use a step of at least 1/)
    expect(() => parse('*/1.5 * * * *')).toThrow(/minute '\*\/1.5' must use a whole-number step/)
    expect(() => parse('1/2/3 * * * *')).toThrow(/minute '1\/2\/3' has more than one step/)
    expect(() => parse('15, * * * *')).toThrow(/minute has an empty item/)
    expect(() => parse('x * * * *')).toThrow(/minute 'x' is not a number/)
    expect(() => parse('* * * ju *')).toThrow(/month 'ju' is ambiguous \(jun, jul\)/)
    expect(() => parse('* * * foo *')).toThrow(/month 'foo' is not a month name or number \(1-12\)/)
    expect(() => parse('* * * * xyz')).toThrow(/day-of-week 'xyz' is not a day-of-week name or number \(0-7\)/)
    // The caller's own label leads the message: a rejection has to name the row field.
    expect(() => parseCronExpression('nope', "agent-team routines[0].cron")).toThrow(/^agent-team routines\[0\]\.cron /)
  })
})

describe('cron next occurrence', () => {
  it('fires strictly after the instant it is asked about', () => {
    expect(fires('*/15 * * * *', '2026-09-25T00:00:00.000Z', 3)).toEqual([
      '2026-09-25T00:15:00.000Z',
      '2026-09-25T00:30:00.000Z',
      '2026-09-25T00:45:00.000Z',
    ])
    expect(next('*/15 * * * *', '2026-09-25T00:15:00.000Z')).toBe('2026-09-25T00:30:00.000Z')
    expect(next('0 0 * * *', '2026-09-25T00:00:00.000Z')).toBe('2026-09-26T00:00:00.000Z')
    expect(next('0 0 1 * *', '2026-09-25T00:00:00.000Z')).toBe('2026-10-01T00:00:00.000Z')
    expect(fires('30 9 * * *', '2026-09-25T00:00:00.000Z', 2)).toEqual([
      '2026-09-25T09:30:00.000Z',
      '2026-09-26T09:30:00.000Z',
    ])
  })

  it('skips whole disallowed months instead of scanning them', () => {
    expect(next('0 0 29 2 *', '2026-09-25T00:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z')
    expect(next('0 0 31 1 *', '2026-01-31T00:00:00.000Z')).toBe('2027-01-31T00:00:00.000Z')
    expect(next('0 12 * 12 *', '2026-01-01T00:00:00.000Z')).toBe('2026-12-01T12:00:00.000Z')
  })

  it('applies Vixie day rule: two restricted day fields mean either, otherwise both', () => {
    // 2026-08-31 is a Monday and 2026-09-01 is the following Tuesday, so the
    // expression below fires on both in a row — the two halves of the rule.
    expect(fires('0 9 1 * 1', '2026-08-31T00:00:00.000Z', 4)).toEqual([
      '2026-08-31T09:00:00.000Z',
      '2026-09-01T09:00:00.000Z',
      '2026-09-07T09:00:00.000Z',
      '2026-09-14T09:00:00.000Z',
    ])
    // A restricted day-of-week beside an unrestricted day-of-month stands alone.
    expect(next('0 9 * * 1', '2026-09-01T00:00:00.000Z')).toBe('2026-09-07T09:00:00.000Z')
    // And a restricted day-of-month beside an unrestricted day-of-week does too.
    expect(next('0 9 3 * *', '2026-09-01T00:00:00.000Z')).toBe('2026-09-03T09:00:00.000Z')
    // `*/1` is restricted, so the two fields combine with OR rather than AND:
    // every day matches on the day-of-month, and the Wednesday clause adds nothing.
    expect(next('0 9 */1 * 3', '2026-09-01T00:00:00.000Z')).toBe('2026-09-01T09:00:00.000Z')
    expect(next('0 9 * * 3', '2026-09-01T00:00:00.000Z')).toBe('2026-09-02T09:00:00.000Z')
  })

  it('refuses nothing at parse time but reports an expression that cannot fire', () => {
    // Grammar-valid, yet no February has ever had a 30th: the one failure an
    // unattended producer could never report, so the search must answer undefined.
    expect(next('0 0 30 2 *', '2026-09-25T00:00:00.000Z')).toBeUndefined()
    expect(fires('0 0 30 2 *', '2026-09-25T00:00:00.000Z', 3)).toEqual([])
    expect(next('0 0 31 4 *', '2026-09-25T00:00:00.000Z')).toBeUndefined()
    expect(CRON_SEARCH_HORIZON_MS).toBe(5 * 366 * 24 * 60 * 60 * 1000)
  })

  it('evaluates in the zone it is given', () => {
    expect(next('0 9 * * *', '2026-09-23T23:00:00.000Z', 'Asia/Tokyo')).toBe('2026-09-24T00:00:00.000Z')
    expect(next('0 0 * * *', '2026-09-25T01:00:00.000Z', 'America/Los_Angeles')).toBe('2026-09-25T07:00:00.000Z')
    expect(cronTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo')
    expect(cronTimeZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(() => next('0 0 * * *', '2026-09-25T00:00:00.000Z', 'Mars/Olympus')).toThrow(/unknown time zone 'Mars\/Olympus'/)
  })

  it('skips a wall reading the clock jumped over, and reports a repeated one once', () => {
    // America/New_York springs forward on 2026-03-08: 02:30 never happens that day.
    expect(next('30 2 * * *', '2026-03-08T00:00:00.000Z', 'America/New_York')).toBe('2026-03-09T06:30:00.000Z')
    // The day before it does, at 07:30Z (EST, UTC-5).
    expect(next('30 2 * * *', '2026-03-07T00:00:00.000Z', 'America/New_York')).toBe('2026-03-07T07:30:00.000Z')
    // It falls back on 2026-11-01: 01:30 happens twice, and both reads are one fire.
    expect(next('30 1 * * *', '2026-11-01T04:00:00.000Z', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
    const twice = nextCronOccurrences(parse('30 1 * * *'), Date.parse('2026-11-01T04:00:00.000Z'), 2, 'America/New_York')
    expect(twice.map(instant => new Date(instant).toISOString())).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ])
  })

  it('returns ascending instants and never an instant at or before the one asked about', () => {
    const from = Date.parse('2026-11-01T04:00:00.000Z')
    const occurrences = nextCronOccurrences(parse('*/20 * * * *'), from, 200, 'America/New_York')
    expect(occurrences).toHaveLength(200)
    expect(occurrences.every(instant => instant > from)).toBe(true)
    expect([...occurrences].sort((a, b) => a - b)).toEqual(occurrences)
    expect(nextCronOccurrences(parse('*/20 * * * *'), from, 0)).toEqual([])
  })
})
