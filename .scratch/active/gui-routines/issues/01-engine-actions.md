# 01 — a stored routine fires either as a wake or as a posted Message

**What to build:** a routine that lives in the GUI's store fires unattended and does exactly one of two things: it wakes one named Member in that Member's own Session, or it commits one Message into one chosen Channel as the Human, whose body mentions wake the Members it names. Every fire is recorded with which of the two happened and what it produced.
**Blocked by:** None — the store slice (`eefbf4f`) is already in.
**Status:** complete (2026-09-25).

- [x] A declaration with no `kind` keeps behaving exactly as before, so every pre-existing config and store entry still runs unchanged.
- [x] A `kind: 'post'` declaration requires the branded Workspace and Channel refs, a body, and its mentions; an unusable declaration fails while the row mounts, naming the offending entry and field.
- [x] A posted fire commits a new taskless Thread as the Human, and each configured handle the body does not already carry is rendered as `@handle` in front of it, because the mention is what notifies and starts the Member's turn.
- [x] The fire log distinguishes a delivered wake from a posted Message, and a refused post is recorded with its own reason rather than being reported as a failed wake.
- [x] The scheduler reports which lane a fire took, so the row records and logs it without re-reading the routine.
