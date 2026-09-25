# 01 — a stored routine fires as a wake (built as a wake or a posted Message)

**What to build:** a routine that lives in the GUI's store fires unattended and wakes one named Member in that
Member's own Session. Every fire is recorded with what the wake did or why it did not land.
**Blocked by:** None — the store slice (`eefbf4f`) is already in.
**Status:** complete (2026-09-25), then narrowed: the wake-only redirect later the same day removed the `post` half,
so the post criteria below record what `7eda414` built and no longer describe the engine. See [../spec.md](../spec.md).

- [x] A declaration with no `kind` keeps behaving exactly as before, so every pre-existing config and store entry still runs unchanged.
- [x] ~~A `kind: 'post'` declaration requires the branded Workspace and Channel refs, a body, and its mentions; an unusable declaration fails while the row mounts, naming the offending entry and field.~~ Removed with the action.
- [x] ~~A posted fire commits a new taskless Thread as the Human, and each configured handle the body does not already carry is rendered as `@handle` in front of it, because the mention is what notifies and starts the Member's turn.~~ Removed with the action.
- [x] ~~The fire log distinguishes a delivered wake from a posted Message, and a refused post is recorded with its own reason rather than being reported as a failed wake.~~ Removed with the action; the log now records `delivered`, `failed`, or `not-armed`.
- [x] The scheduler reports the delivery mode of a wake (`followup` for an idle Member, `steer` for a busy one), so the row records and logs it without re-reading the routine.
