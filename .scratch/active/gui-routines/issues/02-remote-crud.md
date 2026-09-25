# 02 — the Host exposes the routine store to the Client

**What to build:** the Team GUI can read the current routine list, save a routine, and delete one, through the Host — so a Human edits the schedule from the interface and the running Host re-arms from it. The GUI-created set and the operator's `config.routines` stay distinguishable, and an edit the Host cannot run is refused with the reason the Human has to act on.
**Blocked by:** None — `01` is complete and the store already reads, validates, and watches the file.
**Status:** ready

- [ ] A Human opens the routine surface and sees the routines that exist, each with the Channel it posts into and its schedule.
- [ ] Saving a routine — new or edited — validates it before anything lands, and a rejected save reports which field is wrong without disturbing the routines that already run.
- [ ] Deleting a routine stops it firing, without a Host restart, and the fire log already recorded what it did before.
- [ ] A routine the operator declared in the row's own `config` is visible to the Human as declared there and is not editable into the store under the same name.
- [ ] The surface and the Remote method names are declared once in the Host's typed Remote contract and reach the Client through the generated artifacts, never hand-written.
