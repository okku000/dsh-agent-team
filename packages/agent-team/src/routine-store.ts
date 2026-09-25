/**
 * The durable store of routines an operator creates from the Team GUI.
 *
 * The row's `config.routines` is the operator's declaration, and it stays
 * exactly that: a hand-written file the Host reads and never rewrites. A routine
 * created from the GUI cannot live there — the profile's YAML belongs to the
 * operator, and a live edit must not rewrite it behind their back. So
 * GUI-managed routines live beside the fire log, in
 * `$DSH_HOME/agent-team/routines/routines.json`, which this module reads,
 * validates with the same {@link normalizeRoutines} the config path uses, and
 * replaces atomically.
 *
 * Three rules keep the two sources from fighting:
 *
 * - The store is the authority for a name it declares. A config entry with the
 *   same name is shadowed, not duplicated — otherwise the same routine would be
 *   armed twice and fire twice.
 * - An unusable store never blocks the Host. A routine that cannot run is a
 *   routine this store must not arm, and the operator has to hear about it, but
 *   the config-declared routines still run: one warn, one empty list.
 * - A write is validated before it is written and lands by rename, so a reader
 *   never sees half a file and a rejected edit leaves the previous one intact.
 *
 * The file is deliberately plain JSON with no Host state of its own: the
 * schedule, not the fire history, is what an operator edits, and every fire is
 * already recorded in the append-only log next to it.
 *
 * A routine saved through the Host also records who saved it and when. An Agent
 * Member may create one as well as the Human, so "who scheduled this?" has to
 * stay answerable after the fact. Those keys are this
 * store's own: a caller's bookkeeping never enters, and the schedule's
 * validator reads only the fields it knows, so an entry written before
 * attribution existed still loads and still runs.
 * @module @wowyuarm/dsh-agent-team/routine-store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { normalizeRoutines, type Routine, type RoutineConfig } from './routine-schedule.ts'
import type { AgentTeamActor } from './types/entities.ts'

/** Path segments of the store under the Harness home, beside `fires.jsonl`. */
const STORE_SEGMENTS = ['agent-team', 'routines', 'routines.json'] as const

/** The store's own format version; a future migration reads this rather than guessing. */
const STORE_VERSION = 1

/** How long a burst of writes is allowed to settle before a watcher re-reads the file. */
const WATCH_DEBOUNCE_MS = 50

/** The stored file, as written. */
interface StoredRoutineFile {
  readonly version: number
  readonly routines: readonly RoutineConfig[]
}

/**
 * One stored routine: the declaration plus the bookkeeping this store owns.
 *
 * `createdBy` is the first save's author and `updatedBy` the last one, so a
 * routine an agent replaced still reports whose scheduling it was. Both are
 * optional because a store an earlier version wrote — or an operator edited by
 * hand — carries neither, and that entry runs exactly the same.
 */
export interface StoredRoutine extends RoutineConfig {
  /** Who first saved this routine through the Host, and when. */
  readonly createdBy?: AgentTeamActor
  readonly createdAt?: string
  /** Who last replaced it through the Host, and when; absent while only the first save has happened. */
  readonly updatedBy?: AgentTeamActor
  readonly updatedAt?: string
}

/** Absolute path of the durable routine store. */
export function routineStorePath(): string {
  return dshHomePath(...STORE_SEGMENTS)
}

/** One refusal naming the store and what is wrong with it; the reason is the operator's answer. */
function storeFault(path: string, condition: 'unreadable' | 'unusable', error: unknown): Error {
  return new Error(`the routine store at '${path}' is ${condition} (${error instanceof Error ? error.message : String(error)})`)
}

/**
 * Read the store's entries exactly as the file holds them, bookkeeping included.
 *
 * An absent store is the normal first-run state. Anything else that does not
 * read back is an error rather than an empty list, because the caller about to
 * write must never replace routines it could not read.
 * @param path - absolute store path.
 * @returns the entries in file order, or an empty list when there is no store.
 * @throws Error naming the path when the store cannot be read or cannot run.
 */
export function readStoredRoutines(path: string): readonly StoredRoutine[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([])
    throw storeFault(path, 'unreadable', error)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the file must hold an object with a routines list')
    const { routines } = parsed as StoredRoutineFile
    if (!Array.isArray(routines)) throw new Error('routines must be a list')
    normalizeRoutines(routines)
    return Object.freeze(routines.map(entry => Object.freeze({ ...entry })))
  } catch (error) {
    throw storeFault(path, 'unusable', error)
  }
}

/**
 * Read the store's declarations for the schedule.
 *
 * The entry shape is validated by the schedule's own validator: a store is a
 * second way to write the same declaration, never a second definition of it.
 * An unusable store costs the schedule its own entries and never the ones the
 * operator declared on the row, so this reader degrades where
 * {@link readStoredRoutines} refuses.
 * @param path - absolute store path.
 * @param warn - sink for the one warning an unreadable or unusable store produces.
 * @returns the declared routines in file order, or an empty list.
 */
export function readRoutineStore(path: string, warn: (message: string) => void): readonly StoredRoutine[] {
  try {
    return readStoredRoutines(path)
  } catch (error) {
    warn(`agent-team routines: ${error instanceof Error ? error.message : String(error)}; config-declared routines still run`)
    return Object.freeze([])
  }
}

/**
 * Replace the store's declarations atomically.
 *
 * The list is validated first: a store that cannot run must never replace one
 * that can, so a rejected edit reports its reason and leaves the file alone.
 * @param path - absolute store path.
 * @param routines - the full declaration list to write.
 * @throws Error when a declaration cannot run, or when the file cannot be written.
 */
export function writeRoutineStore(path: string, routines: readonly RoutineConfig[]): void {
  normalizeRoutines(routines)
  const text = `${JSON.stringify({ version: STORE_VERSION, routines }, null, 2)}\n`
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, text)
  try {
    renameSync(temporary, path)
  } catch (error) {
    // POSIX rename(2) replaces the target silently; Windows refuses to replace
    // an existing file, so the target goes first. A reader is never left with
    // half a file either way, because the content only ever appears by rename.
    void error
    rmSync(path, { force: true })
    renameSync(temporary, path)
  }
}

/**
 * The routines this Host runs: the store's declarations, then every
 * config-declared routine whose name the store does not already own.
 *
 * The two lists are validated independently, so a broken declaration is
 * reported as a broken declaration rather than as a broken store entry.
 * @param stored - the store's declarations, as read.
 * @param declared - the row's `config.routines`, read as untrusted input.
 * @returns the frozen, validated routines in the order the Host arms them.
 * @throws Error naming the offending entry when the operator's config cannot run.
 */
export function mergeRoutines(stored: readonly RoutineConfig[], declared: unknown): readonly Routine[] {
  const fromConfig = normalizeRoutines(declared)
  const fromStore = normalizeRoutines(stored)
  const shadowed = new Set(fromStore.map(routine => routine.name))
  return Object.freeze([...fromStore, ...fromConfig.filter(routine => !shadowed.has(routine.name))])
}

/** The declaration keys this store fills in itself; a caller's own attribution never enters. */
const STORE_OWNED_KEYS = new Set(['createdBy', 'createdAt', 'updatedBy', 'updatedAt'])

/** One routine's own fields, with the store's bookkeeping keys dropped. */
function declarationOf(entry: RoutineConfig): RoutineConfig {
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!STORE_OWNED_KEYS.has(key)) fields[key] = value
  }
  return fields as unknown as RoutineConfig
}

/**
 * Save one routine, replacing the entry of that name in place.
 *
 * The whole resulting list is validated before anything is written, so a save
 * the Host cannot run leaves every routine that already runs untouched. The
 * read-modify-write is synchronous on purpose: one Host serves the GUI Remote
 * and every Agent tool in one process, and with no `await` between them two
 * saves cannot interleave and lose one another's entry.
 * @param path - absolute store path.
 * @param declaration - the routine to save, as its caller wrote it.
 * @param author - who is saving it.
 * @param savedAt - the save instant, ISO 8601.
 * @returns the stored entry and whether this save created it.
 * @throws Error when the store cannot be read, or the result cannot run.
 */
export function saveStoredRoutine(path: string, declaration: RoutineConfig, author: AgentTeamActor, savedAt: string): { readonly routine: StoredRoutine; readonly created: boolean } {
  const entries = readStoredRoutines(path)
  const index = entries.findIndex(entry => entry.name === declaration.name)
  const previous = index === -1 ? undefined : entries[index]
  // A replacement keeps the attribution of the save that scheduled the routine
  // and adds this one: an agent that takes over a name has not thereby become
  // its creator, and the Human still reads who originally put it there.
  const attribution = previous === undefined
    ? { createdBy: author, createdAt: savedAt }
    : {
        ...(previous.createdBy === undefined ? {} : { createdBy: previous.createdBy }),
        ...(previous.createdAt === undefined ? {} : { createdAt: previous.createdAt }),
        updatedBy: author,
        updatedAt: savedAt,
      }
  const entry: StoredRoutine = Object.freeze({ ...declarationOf(declaration), ...attribution })
  const next = index === -1 ? [...entries, entry] : entries.map((existing, at) => at === index ? entry : existing)
  writeRoutineStore(path, next)
  return Object.freeze({ routine: entry, created: index === -1 })
}

/**
 * Delete one routine by name.
 *
 * Deleting a name the store does not hold changes nothing and reports so: the
 * name is the identity, so this operation is idempotent by construction.
 * @param path - absolute store path.
 * @param name - the routine name to remove.
 * @returns whether an entry was removed.
 * @throws Error when the store cannot be read, or the result cannot run.
 */
export function deleteStoredRoutine(path: string, name: string): { readonly removed: boolean } {
  const entries = readStoredRoutines(path)
  const next = entries.filter(entry => entry.name !== name)
  if (next.length === entries.length) return Object.freeze({ removed: false })
  writeRoutineStore(path, next)
  return Object.freeze({ removed: true })
}

/**
 * Call `onChange` whenever the store file is created, replaced, or removed.
 *
 * The directory is watched rather than the file, because the store is replaced
 * by rename: a watcher bound to the old inode would stop seeing writes after the
 * first one. Writes are debounced, since one logical edit is a temporary file
 * plus a rename.
 * @param path - absolute store path.
 * @param onChange - called after a burst of writes settles.
 * @param warn - sink for the one warning an unwatchable directory produces.
 * @returns the disposer, which never throws.
 */
export function watchRoutineStore(path: string, onChange: () => void, warn: (message: string) => void): () => void {
  const directory = dirname(path)
  const fileName = basename(path)
  let watcher: FSWatcher
  try {
    mkdirSync(directory, { recursive: true })
    watcher = watch(directory)
  } catch (error) {
    // A directory this Host cannot watch costs live re-arming, not the schedule
    // that was already read: the store still applies on the next mount.
    warn(`agent-team routines: the routine store at '${path}' cannot be watched (${error instanceof Error ? error.message : String(error)}); GUI edits apply on the next restart`)
    return () => {}
  }
  let timer: NodeJS.Timeout | undefined
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, WATCH_DEBOUNCE_MS)
  }
  watcher.on('change', (_event, changed) => {
    // Some platforms report no name at all; those re-read, because the debounce
    // already collapses the temporary file's own event into one call.
    if (changed !== null && changed !== fileName) return
    schedule()
  })
  watcher.on('error', error => {
    warn(`agent-team routines: the routine store watcher failed (${error instanceof Error ? error.message : String(error)}); GUI edits apply on the next restart`)
  })
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    watcher.close()
  }
}

/** The temporary file a store write lands through, exported for tests and cleanup. */
export function routineStoreTemporaryPath(path: string): string {
  return join(dirname(path), `${basename(path)}.tmp`)
}
