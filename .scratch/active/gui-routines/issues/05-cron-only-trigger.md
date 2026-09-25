# 05 — one cron expression is the only trigger

**What to build:** the Human asked for 「全部cron式に。cron式のみにしてシンプルに管理したい」 — a routine's whole trigger is one
five-field cron expression, and every other way of saying when has left the product. A Human writes the expression in
the GUI with the next fires previewed under it, an Agent Member writes it through `team_routine`, an operator writes
it in `config.routines`, and all three are read by one parser in the Host's own clock.
**Blocked by:** None — the store, the wake-only engine, the Host routine API, and the global surface had landed.
**Status:** complete

- [x] A declaration is `{ cron, once? }` and nothing else: the expression is five fields, read in the Host's own zone, and `once: true` means "at the next occurrence, and then never again".
- [x] The three former trigger fields are refused by name, each naming the replacement to write instead, and an expression that cannot fire within five years is refused with the zone it was read in.
- [x] Host and Client read expressions with the same module, so what the editor previews is what the Host arms; the API reports the zone, and the editor draws the grammar, the zone, and the next three fires under the field.
- [x] A spent one-shot cannot fire twice: a delivered fire record carries `once`, the log trim keeps those lines, and the store's routines that already fired are left disarmed at mount and at every re-arm, so only delete + re-save arms one again.
- [x] Re-arming happens from the settled instant, so the expression owns the phase and a slow delivery skips the occurrences it outlived instead of firing a catch-up burst.
- [x] Both sides of the documented contract describe the shipped behaviour — the package README pairs, `team-collaboration/tools.md`, `team-collaboration/attention-and-messaging.md`, `frontend-design/sidebar-browser.md`, and `CHANGELOG.md` — and `04` stays open and unchanged behind it.

## Legacy → cron

Nothing shipped with the old trigger, so there is no migration to run; the table is what the refusal messages say,
and it is here so the mapping does not have to be re-derived.

| Old declaration | Cron-only form |
| --- | --- |
| `everySeconds: 3600` | `0 * * * *` |
| `everySeconds: 86400` | `0 0 * * *` |
| `everySeconds: 900` | `*/15 * * * *` |
| `everySeconds: n` where `n` does not divide the minute cycle | the occurrence grid closest to the intent, written out (`30 2 * * *` rather than a raw second count) |
| `at: '2026-09-09T01:00:00.000Z'` | `cron: '0 9 * * *'` with `once: true`, read in the Host's zone |
| `anchorAt: <instant>` | dropped — the phase belongs to the expression, not to when the row armed |

`once: true` deliberately survives the redirect: a cron expression carries no year, so it is the only way to say
"just this one".

## What changed where

- A new pure module holds the grammar, the next-occurrence search, the zone, and the five-year horizon, and it is
  published as its own subpath so the Client imports the Host's parser rather than growing a second opinion.
- The schedule contract became `{ cron, once? }`; the legacy names are refused before anything is armed, and the
  never-fires check runs at save time rather than being left to fail silently after a Host restart.
- The engine arms each routine for its next occurrence and re-arms from the moment a delivery settled, so the
  `due` bookkeeping the interval model needed is gone.
- The one-shot memory moved into the producer's own fire log: a delivered record states whether it was a one-shot,
  those lines survive the trim, and the store filters spent names out at mount and on every re-arm.
- The tool row carries `cron` and the listing footer carries the zone; the Client's editor is one expression field
  with a live preview, and the `once` checkbox stays.

## Follow-ups this ticket does not own

- `04` is untouched: a fire's outcome is still a line in the fire log that no Remote reads.
- The old forms are refused, not accepted-and-translated. If an operator ever needs an automatic rewrite of a
  `config.routines` entry, that is a new ticket; today the refusal names the expression to write.
