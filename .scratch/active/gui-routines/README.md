# Routines created from the Team GUI

Status: in progress — the store, the wake-only engine, the Host API, the agent tool, the global surface, and the
cron-only trigger are landed; a fire's outcome on that surface remains.
Last checked: 2026-09-26.

## Redirect: cron only

On 2026-09-26 the Human narrowed the trigger itself: 「全部cron式に。cron式のみにしてシンプルに管理したい」. The interval,
anchor, and absolute-instant forms therefore left the schedule contract, the engine, the store's validation, the
`team_routine` tool, and the Client editor in one change, and a routine is now `{ cron, once? }` — one five-field
expression read on the Host's own clock, with `once: true` for a single fire. Host and Client share one parser
through a new subpath export. `05` is complete; nothing shipped with the old forms, so there is no migration to run
and the mapping lives in [#05](issues/05-cron-only-trigger.md).

## Redirect: wake only

The same day, after `02` landed, the Human narrowed the feature to one action: 「各エージェントをwakeするやり方一本で行こうと思う」.
The `kind: 'post'` lane therefore left the engine, the store contract, the `team_routine` tool, and the docs in one
`refactor:` commit over `7eda414`. What remains is the simpler contract: a routine names one Member and one
instruction, and the Member decides what to do about it. Nothing was lost in the real environment, which held no
stored routine. The post design stays readable in [spec.md](spec.md) as withdrawn history, and that isolated commit
is what a reversal would revert.

## Current frontier

The engine is wake-only, the store (`eefbf4f`) makes a GUI-written routine take effect without a profile edit or a
Host restart, `02` landed the Host routine API plus the model-facing `team_routine` tool, and `03` landed the global
surface: a Human can now see, create, edit, and delete every routine beside the Inbox, and an entry the operator
declared in the profile is listed and marked rather than offered for edit.

That closes the Human's stated payoff — scheduling something by saying it to an agent is visible and editable end to
end — except for one thing: the surface shows the schedule, not what a fire did. A delivered or refused fire is a
line in the Host's fire log and nothing reads it, so `04` is the remaining slice. `05` then simplified the trigger
to one cron expression, which is a contract change rather than a new slice of the surface.

Blocked: nothing. `04` is the frontier.

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

Partly done. The store and the wake-only routine contract are described in the package README pair ("Routines") and
in `docs/team-collaboration/attention-and-messaging.md`; the agent-facing tool has its row in the Team tool set
documentation; and the global surface now has its sentence and its creation copy in the client package README pair
and in `frontend-design/sidebar-browser.md`, with `CHANGELOG.md` naming the entry.

One fire-outcome sentence is deliberately written as a boundary rather than as shipped behaviour, because that is
what the code does: the page lists the schedule, and the outcome stays in the Host's fire log. `04` replaces that
sentence with the real contract once the read exists.

## Slices

- `issues/01-engine-actions.md` — complete through `7eda414`, then narrowed by the wake-only redirect; its post
  criteria are historical.
- `issues/02-host-api-and-agent-tool.md` — complete: the Host routine API plus `team_routine`.
- `issues/03-global-routines-surface.md` — complete: the global surface that lists, creates, edits, and deletes.
- `issues/04-fire-outcome-on-the-surface.md` — the frontier: a fire's outcome on that surface.
- `issues/05-cron-only-trigger.md` — complete: one cron expression as the only trigger, shared by Host and Client.

Confirmed scope, the resolved UI placement, and the authority note about agent-created routines: [spec.md](spec.md).
