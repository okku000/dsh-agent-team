# Routines created from the Team GUI

Status: in progress — the store, the wake-only engine, the Host API, and the agent tool are landed; the global surface remains.
Last checked: 2026-09-25.

## Redirect: wake only

The same day, after `02` landed, the Human narrowed the feature to one action: 「各エージェントをwakeするやり方一本で行こうと思う」.
The `kind: 'post'` lane therefore left the engine, the store contract, the `team_routine` tool, and the docs in one
`refactor:` commit over `7eda414`. What remains is the simpler contract: a routine names one Member and one
instruction, and the Member decides what to do about it. Nothing was lost in the real environment, which held no
stored routine. The post design stays readable in [spec.md](spec.md) as withdrawn history, and that isolated commit
is what a reversal would revert.

## Current frontier

The engine is wake-only, the store (`eefbf4f`) makes a GUI-written routine take effect without a profile edit or a
Host restart, and `02` landed the Host routine API plus the model-facing `team_routine` tool.

Nothing can *write* the store from the Client yet: the global surface is the last slice, and it is what makes the
Human's stated payoff — scheduling something by saying it to an agent — visible and editable end to end.

Blocked: nothing. `03` is the frontier.

## Completion conditions

- A Human creates, edits, and deletes a routine from one global Team surface that lists every routine, and the
  running Host arms the change without a restart.
- An Agent Member creates a routine through a Team tool, and a routine created that way fires; the surface shows
  who created it.
- A routine fires into its named Member's own Session, and the woken Member's turn is the only trace it leaves on
  the Team.
- A refused fire (an unknown Member, or a Member that is not enabled or has no live Session) is visible to the Human
  as an outcome, not only as a line in the fire log.
- Both sides of the documented contract (package README pair, the attention-and-messaging pair, `CHANGELOG.md`)
  describe the shipped behaviour with no `> TODO:` left behind.

## Formal-doc exit

Not yet. The store and the wake-only routine contract are described in the package README pair ("Routines") and in
`docs/team-collaboration/attention-and-messaging.md`, and the agent-facing tool has its row in the Team tool set
documentation. The global surface needs its sentence and its creation copy once it ships.

## Slices

- `issues/01-engine-actions.md` — complete through `7eda414`, then narrowed by the wake-only redirect; its post
  criteria are historical.
- `issues/02-host-api-and-agent-tool.md` — complete: the Host routine API plus `team_routine`.
- `issues/03-global-routines-surface.md` — the frontier.

Confirmed scope, the resolved UI placement, and the authority note about agent-created routines: [spec.md](spec.md).
