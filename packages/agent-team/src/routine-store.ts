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
 * @module @wowyuarm/dsh-agent-team/routine-store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { normalizeRoutines, type Routine, type RoutineConfig } from './routine-schedule.ts'

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

/** Absolute path of the durable routine store. */
export function routineStorePath(): string {
  return dshHomePath(...STORE_SEGMENTS)
}

/**
 * Read the store's declarations.
 *
 * The entry shape is validated by the schedule's own validator: a store is a
 * second way to write the same declaration, never a second definition of it.
 * @param path - absolute store path.
 * @param warn - sink for the one warning an unreadable or unusable store produces.
 * @returns the declared routines in file order, or an empty list.
 */
export function readRoutineStore(path: string, warn: (message: string) => void): readonly RoutineConfig[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // An absent store is the normal first-run state, not a fault: the GUI has
    // simply never saved anything.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`agent-team routines: the routine store at '${path}' is unreadable (${error instanceof Error ? error.message : String(error)}); config-declared routines still run`)
    }
    return Object.freeze([])
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the file must hold an object with a routines list')
    const { routines } = parsed as StoredRoutineFile
    if (!Array.isArray(routines)) throw new Error('routines must be a list')
    normalizeRoutines(routines)
    return Object.freeze(routines.map(entry => Object.freeze({ ...entry })))
  } catch (error) {
    warn(`agent-team routines: the routine store at '${path}' is unusable (${error instanceof Error ? error.message : String(error)}); config-declared routines still run`)
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
