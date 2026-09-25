# Routines created from the Team GUI

Status: in progress — the store and the engine's two actions are landed; the Remote CRUD and the settings section remain.
Last checked: 2026-09-25.

## Current frontier

A Human can already create a routine from the GUI in the sense that one written into the GUI's store fires without
a profile edit or a Host restart (`eefbf4f`), and an entry can now act two ways: `wake` (default, the pre-existing
behaviour) or `kind: 'post'`, which commits one Message into a chosen Channel as the Human with a body mention that
notifies and wakes the Members it names. Nothing in the GUI writes that store yet, and no routine can be created,
listed, edited, or deleted from the interface — the next slice is the Host's Remote CRUD surface, then the settings
section that calls it.

Blocked: nothing. The two remaining tickets are a serial chain, `02` then `03`.

## Completion conditions

- A Human creates, edits, and deletes a routine entirely in the Team GUI, choosing one Channel for it, and the
  running Host arms the change without a restart.
- A posted routine's mention notifies exactly the Members it names — verified in the browser against a real
  mention chip, Inbox entry, and Member turn, not only in unit tests.
- A refused fire (unknown Channel, a Member who cannot be mentioned) is visible to the Human as an outcome, not
  only as a line in the fire log.
- Both sides of the documented contract (package README pair, the attention-and-messaging pair, `CHANGELOG.md`)
  describe the shipped behaviour with no `> TODO:` left behind.

## Formal-doc exit

Not yet. The store is described in the package README pair ("Routines"); the action union and the `posted` fire
record are described there and in `docs/team-collaboration/attention-and-messaging.md`. The Remote CRUD surface and
the settings section each need their own sentence there once shipped.

## Slices

- `issues/01-engine-actions.md` — complete.
- `issues/02-remote-crud.md` — ready.
- `issues/03-client-settings.md` — blocked by `02`.

Confirmed scope and design decisions: [spec.md](spec.md).
