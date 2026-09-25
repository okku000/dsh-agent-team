/**
 * The five-field cron expression: parsing, validation, and the next fire.
 *
 * A routine's trigger is one cron expression and nothing else — five fields,
 * `minute hour day-of-month month day-of-week` — so the whole schedule model
 * fits in one string a Member can write, the GUI can edit, and an operator can
 * read. This module is the single authority for that grammar: the Host validates
 * and arms from it, and the Client editor parses the very same string with the
 * very same code to preview the next fires, so the surface can never disagree
 * with the producer about what an expression means.
 *
 * Everything here is pure — no cordis, no I/O, no clock of its own beyond the
 * `fromMs` its callers pass — because the two failures that matter are both
 * found by arithmetic rather than by running: an expression that is malformed
 * (refused loudly at validation, with the field named) and an expression that
 * is well-formed but can never fire, such as `0 0 30 2 *`. The second is the
 * dangerous one: an unattended routine that never fires reports nothing, so it
 * is refused up front instead of silently doing nothing for years.
 *
 * Two deliberate departures from a naive reading of the manual:
 *
 * - The day rule is Vixie's. When BOTH `day-of-month` and `day-of-week` are
 *   restricted (neither is literally `*`), the day matches when EITHER does;
 *   otherwise both must match. That is what every crontab on the machine does,
 *   and an operator's `0 9 1 * 1` means "the 1st, and every Monday".
 * - Time is wall-clock time in one zone. The zone is the Host's local zone
 *   unless a caller names an IANA zone; an instant that does not exist because
 *   the clock jumped forward is skipped, and one that occurs twice because it
 *   jumped back is reported once. `Intl` supplies the zone data, so no timezone
 *   database ships with this package.
 * @module @wowyuarm/dsh-agent-team/cron
 */

/** One field of an expression, as parsing produced it. */
export interface CronField {
  /** The field exactly as written, for messages and the round trip. */
  readonly source: string
  /** Every allowed value, ascending and deduplicated. */
  readonly values: readonly number[]
  /**
   * Whether the field constrains anything: `*` does not, everything else —
   * including `*&#47;1` — does. The day rule turns on this distinction.
   */
  readonly restricted: boolean
}

/** A parsed expression; every field has already been range-checked. */
export interface CronExpression {
  /** The expression as written, whitespace-normalized. */
  readonly source: string
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

/** How far ahead validation looks before calling an expression unable to fire. */
export const CRON_SEARCH_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000

/** One minute in milliseconds. */
const MINUTE_MS = 60_000

/** One hour in milliseconds. */
const HOUR_MS = 3_600_000

/** One day in milliseconds; wall-clock arithmetic, so it is always 24 hours. */
const DAY_MS = 86_400_000

/** Iteration guard: a bug must fail loudly rather than spin a Host forever. */
const MAX_STEPS = 200_000

/** Field names as an operator writes and reads them. */
const FIELD_LABELS = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const

/** Month names, matched case-insensitively by prefix (`ja`, `jan`, `january`). */
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const

/** Weekday names, matched the same way; `sun` is 0 and `7` is its alias. */
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** Bounds and names of one field, in written order. */
interface FieldSpec {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly names?: readonly string[]
  /** `day-of-week` alone accepts 7 as Sunday and folds it onto 0. */
  readonly fold?: (value: number) => number
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { label: FIELD_LABELS[0], min: 0, max: 59 },
  { label: FIELD_LABELS[1], min: 0, max: 23 },
  { label: FIELD_LABELS[2], min: 1, max: 31 },
  { label: FIELD_LABELS[3], min: 1, max: 12, names: MONTH_NAMES },
  { label: FIELD_LABELS[4], min: 0, max: 7, names: WEEKDAY_NAMES, fold: value => (value === 7 ? 0 : value) },
]

/** The formatter cache: one `Intl.DateTimeFormat` per zone, shared by every call. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/** The offset cache, keyed `zone@instant`, so a search does not re-format a day twice. */
const OFFSETS = new Map<string, number>()

/** Resolve one name, or one number, against a field's allowed values. */
function fieldValue(token: string, spec: FieldSpec, where: string): number {
  if (/^\d+$/.test(token)) {
    const value = Number(token)
    if (value < spec.min || value > spec.max) throw new Error(`${where} '${token}' is out of range ${spec.min}-${spec.max}`)
    return value
  }
  const names = spec.names
  if (names === undefined) throw new Error(`${where} '${token}' is not a number`)
  const lowered = token.toLowerCase()
  // A prefix of exactly one name (`ja`), or a name that the token extends
  // (`january`); anything matching two names is refused as ambiguous rather
  // than resolved to whichever came first in the table.
  let matches = names.filter(name => name.startsWith(lowered))
  if (matches.length === 0) matches = names.filter(name => lowered.startsWith(name))
  if (matches.length === 0) throw new Error(`${where} '${token}' is not a ${spec.label} name or number (${spec.min}-${spec.max})`)
  if (matches.length > 1) throw new Error(`${where} '${token}' is ambiguous (${matches.join(', ')})`)
  const index = names.indexOf(matches[0]!)
  return spec.min + index
}

/** One comma-separated item: `*`, `a`, `a-b`, or any of those with `/n`. */
function itemValues(item: string, spec: FieldSpec, where: string): number[] {
  const slash = item.split('/')
  if (slash.length > 2) throw new Error(`${where} '${item}' has more than one step`)
  const [rangeText, stepText] = slash as [string, string?]
  let step = 1
  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText)) throw new Error(`${where} '${item}' must use a whole-number step`)
    step = Number(stepText)
    if (step < 1) throw new Error(`${where} '${item}' must use a step of at least 1`)
  }
  let low: number
  let high: number
  if (rangeText === '*') {
    low = spec.min
    high = spec.max
  } else if (rangeText!.includes('-')) {
    const bounds = rangeText!.split('-')
    if (bounds.length !== 2 || bounds[0] === '' || bounds[1] === '') throw new Error(`${where} '${item}' is not a valid range`)
    low = fieldValue(bounds[0]!, spec, where)
    high = fieldValue(bounds[1]!, spec, where)
    if (low > high) throw new Error(`${where} '${item}' is not a valid range: ${bounds[0]} is greater than ${bounds[1]}`)
  } else {
    low = fieldValue(rangeText!, spec, where)
    // Vixie's shorthand: `a/n` means "from a to the end of the field, every n".
    high = stepText === undefined ? low : spec.max
  }
  const values: number[] = []
  for (let value = low; value <= high; value += step) values.push(spec.fold === undefined ? value : spec.fold(value))
  return values
}

/** One field of the expression, validated item by item. */
function parseField(text: string, spec: FieldSpec, where: string): CronField {
  const values = new Set<number>()
  for (const item of text.split(',')) {
    if (item === '') throw new Error(`${where} has an empty item`)
    for (const value of itemValues(item, spec, where)) values.add(value)
  }
  return Object.freeze({ source: text, values: Object.freeze([...values].sort((a, b) => a - b)), restricted: text !== '*' })
}

/**
 * Parse and validate one five-field cron expression.
 *
 * Only the five-field form is accepted. `@daily`-style macros and the
 * four-field (no day-of-week) and six-field (with seconds) variants are
 * refused by name, because each of them means something different to a
 * different cron and guessing would make a schedule nobody can predict.
 * @param text - the expression as written.
 * @param where - the label a rejection starts with, so the caller's field is named.
 * @returns the parsed expression, with every field already validated.
 * @throws Error naming the offending field and item.
 */
export function parseCronExpression(text: unknown, where = 'cron'): CronExpression {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error(`${where} must be a non-empty string`)
  const source = text.trim().replace(/\s+/g, ' ')
  if (source.startsWith('@')) {
    throw new Error(`${where} '${source}' uses an unsupported macro; write five fields (${FIELD_LABELS.join(' ')})`)
  }
  const fields = source.split(' ')
  if (fields.length !== 5) {
    throw new Error(`${where} '${source}' must have five fields (${FIELD_LABELS.join(' ')}), got ${fields.length}`)
  }
  const parsed = fields.map((field, index) => parseField(field, FIELD_SPECS[index]!, `${where} ${FIELD_SPECS[index]!.label}`))
  return Object.freeze({
    source,
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
  })
}

/**
 * The zone a search runs in: the caller's IANA name, or the Host's local zone.
 * @param timeZone - an IANA zone name, or undefined for the local zone.
 * @returns the resolved zone name, safe to render and to hand back to `Intl`.
 * @throws Error when the name is not one `Intl` knows.
 */
export function cronTimeZone(timeZone?: string): string {
  if (timeZone === undefined) return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new Error(`unknown time zone '${timeZone}'`)
  }
  return timeZone
}

/** The shared formatter for one zone; `h23` keeps midnight at hour `00`. */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  FORMATTERS.set(timeZone, formatter)
  return formatter
}

/** The wall-clock parts of one instant, in one zone. */
interface WallParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** Read one instant as the zone's own clock; the one place `Intl` is consulted. */
function zoneParts(epochMs: number, timeZone: string): WallParts {
  const parts: Record<string, number> = {}
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  }
}

/** The zone's offset from UTC at one instant, in milliseconds. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const key = `${timeZone}@${epochMs}`
  const cached = OFFSETS.get(key)
  if (cached !== undefined) return cached
  const parts = zoneParts(epochMs, timeZone)
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - epochMs
  if (OFFSETS.size > 4096) OFFSETS.clear()
  OFFSETS.set(key, offset)
  return offset
}

/** One wall-clock reading, held as a UTC-based pseudo-instant so day and month roll over. */
type Wall = number

/** The pseudo-instant a wall reading is stored as; UTC arithmetic keeps it DST-free. */
function wallOf(parts: WallParts): Wall {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

/** The reading a pseudo-instant stands for; the day of week comes from the calendar. */
function wallParts(wall: Wall): WallParts & { readonly dayOfWeek: number } {
  const date = new Date(wall)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: 0,
    dayOfWeek: date.getUTCDay(),
  }
}

/** The real instants a wall reading names: none (skipped), one, or two (repeated). */
function wallInstants(wall: Wall, timeZone: string): number[] {
  const first = wall - zoneOffsetMs(wall, timeZone)
  const second = wall - zoneOffsetMs(first, timeZone)
  const candidates = first === second ? [first] : [Math.min(first, second), Math.max(first, second)]
  const parts = wallParts(wall)
  return candidates.filter(candidate => {
    const seen = zoneParts(candidate, timeZone)
    return seen.year === parts.year && seen.month === parts.month && seen.day === parts.day
      && seen.hour === parts.hour && seen.minute === parts.minute
  })
}

/** The smallest allowed value at or after `from`, or undefined when there is none left. */
function nextAllowed(values: readonly number[], from: number): number | undefined {
  for (const value of values) if (value >= from) return value
  return undefined
}

/** Vixie's day rule: two restricted fields mean either, otherwise both. */
function dayMatches(expression: CronExpression, parts: WallParts & { readonly dayOfWeek: number }): boolean {
  const byDate = expression.dayOfMonth.values.includes(parts.day)
  const byWeekday = expression.dayOfWeek.values.includes(parts.dayOfWeek)
  if (expression.dayOfMonth.restricted && expression.dayOfWeek.restricted) return byDate || byWeekday
  return byDate && byWeekday
}

/** Start of the next day at or after a reading, on the wall clock. */
function startOfNextDay(wall: Wall): Wall {
  return Math.floor(wall / DAY_MS) * DAY_MS + DAY_MS
}

/** Start of the next hour, on the wall clock. */
function startOfNextHour(wall: Wall): Wall {
  return Math.floor(wall / HOUR_MS) * HOUR_MS + HOUR_MS
}

/** Start of the next allowed month, on the wall clock; the field is never empty. */
function startOfNextAllowedMonth(wall: Wall, months: readonly number[]): Wall {
  const parts = wallParts(wall)
  for (let ahead = 1; ahead <= 12; ahead += 1) {
    const candidate = new Date(Date.UTC(parts.year, parts.month - 1 + ahead, 1))
    if (months.includes(candidate.getUTCMonth() + 1)) {
      return Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), 1)
    }
  }
  throw new Error('cron has no allowed month')
}

/**
 * The next instants one expression fires, strictly after `fromMs`.
 *
 * The search walks the wall clock rather than the timeline: a field that does
 * not match skips straight to the next day, hour, or allowed month, and only a
 * reading every field accepts is converted to a real instant and verified. That
 * is what keeps a five-year look-ahead cheap, and what makes the answer right
 * across a daylight-saving transition — a reading the zone skips is passed
 * over, and one the zone repeats is reported once.
 * @param expression - a parsed expression.
 * @param fromMs - the instant to search strictly after.
 * @param count - how many fires to collect.
 * @param timeZone - an IANA zone; defaults to the Host's local zone.
 * @returns the firing instants, ascending; fewer than `count` when the horizon ends first.
 * @throws Error when `timeZone` is not a zone `Intl` knows.
 */
export function nextCronOccurrences(expression: CronExpression, fromMs: number, count: number, timeZone?: string): number[] {
  if (!Number.isFinite(fromMs)) throw new Error('cron next occurrence needs a finite instant')
  if (!Number.isFinite(count) || count < 1) return []
  const zone = cronTimeZone(timeZone)
  const start = wallOf(zoneParts(fromMs, zone))
  const horizon = start + CRON_SEARCH_HORIZON_MS
  const found: number[] = []
  let wall = start + MINUTE_MS
  let after = fromMs
  for (let step = 0; step < MAX_STEPS && found.length < count && wall <= horizon; step += 1) {
    const parts = wallParts(wall)
    if (!expression.month.values.includes(parts.month)) {
      wall = startOfNextAllowedMonth(wall, expression.month.values)
      continue
    }
    if (!dayMatches(expression, parts)) {
      wall = startOfNextDay(wall)
      continue
    }
    if (!expression.hour.values.includes(parts.hour)) {
      const hour = nextAllowed(expression.hour.values, parts.hour)
      wall = hour === undefined ? startOfNextDay(wall) : Math.floor(wall / DAY_MS) * DAY_MS + hour * HOUR_MS
      continue
    }
    if (!expression.minute.values.includes(parts.minute)) {
      const minute = nextAllowed(expression.minute.values, parts.minute)
      wall = minute === undefined
        ? startOfNextHour(wall)
        : Math.floor(wall / HOUR_MS) * HOUR_MS + minute * MINUTE_MS
      continue
    }
    const instant = wallInstants(wall, zone).find(candidate => candidate > after)
    if (instant === undefined) {
      wall += MINUTE_MS
      continue
    }
    found.push(instant)
    after = instant
    wall += MINUTE_MS
  }
  return found
}

/**
 * The next instant one expression fires, or undefined when none lies within the
 * five-year horizon.
 * @param expression - a parsed expression.
 * @param fromMs - the instant to search strictly after.
 * @param timeZone - an IANA zone; defaults to the Host's local zone.
 * @returns the firing instant, or undefined for an expression that never fires.
 */
export function nextCronOccurrence(expression: CronExpression, fromMs: number, timeZone?: string): number | undefined {
  return nextCronOccurrences(expression, fromMs, 1, timeZone)[0]
}
