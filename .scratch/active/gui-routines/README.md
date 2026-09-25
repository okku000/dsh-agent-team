# Routines created from the Team GUI

Status: in progress — the store and the engine's two actions are landed; the Host API, the agent tool, and the global surface remain.
Last checked: 2026-09-25.

## Current frontier

The engine is done and pushed (`7eda414`): a stored routine fires either as `wake` or as `kind: 'post'`, which commits
one Message into a chosen Channel as the Human with a body mention that notifies and wakes the Members it names. The
store (`eefbf4f`) already makes a GUI-written routine take effect without a profile edit or a Host restart.

Nothing can *write* the store except a file edit yet: there is no Host method, no tool, and no surface. The next
slice is therefore the Host routine API plus the model-facing tool, which is what makes the Human's stated payoff —
scheduling something by saying it to an agent — work end to end.

Blocked: nothing. `02` then `03` is a serial chain.

## Completion conditions

- A Human creates, edits, and deletes a routine from one global Team surface that lists every routine, and the
  running Host arms the change without a restart.
- An Agent Member creates a routine through a Team tool, and a routine created that way fires; the surface shows
  who created it.
- A posted routine's mention notifies exactly the Members it names — verified in the browser against a real mention
  chip, Inbox entry, and Member turn, not only in unit tests.
- A refused fire (unknown Channel, a Member who cannot be mentioned) is visible to the Human as an outcome, not
  only as a line in the fire log.
- Both sides of the documented contract (package README pair, the attention-and-messaging pair, `CHANGELOG.md`)
  describe the shipped behaviour with no `> TODO:` left behind.

## Formal-doc exit

Not yet. The store is described in the package README pair ("Routines"); the action union and the `posted` fire
record are described there and in `docs/team-collaboration/attention-and-messaging.md`. The agent-facing tool needs
a row in the Team tool set documentation, and the global surface needs its sentence, once each ships.

## Slices

- `issues/01-engine-actions.md` — complete.
- `issues/02-host-api-and-agent-tool.md` — ready, and the next thing to build.
- `issues/03-global-routines-surface.md` — blocked by `02`.

Confirmed scope, the resolved UI placement, and the authority note about agent-created routines: [spec.md](spec.md).
