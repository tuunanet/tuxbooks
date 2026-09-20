# Issue tracker: bd (Beads)

Issues and specs for this repo live in **bd (Beads)**, the local tracker the
repo already uses. Work through the `bd` CLI; the `beads` skill holds the full
workflow guide, and `bd prime` prints session context (including persistent
memories).

## Rules

- Track every task in `bd`. Do not keep markdown TODO lists, task lists, or any
  other parallel tracker.
- Keep persistent project memory in bd (`bd remember "insight"`); do not create
  `MEMORY.md` files.
- Run `bd prime` when bd context is missing or stale.

## Conventions

| Operation     | Command                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| Create        | `bd create "Title" -p <0-4>` (0 highest); `--parent <id>` for a child           |
| Quick capture | `bd q "..."` (prints only the id)                                               |
| Read          | `bd show <id>`; `bd comments <id>` / `bd note <id> "..."`                       |
| List          | `bd list` (`-s`, `-l`, `-p`, `--type`); `bd ready` = open, unblocked, unclaimed |
| Claim         | `bd update <id> --claim` (sets assignee + in_progress)                          |
| Comment       | `bd comment <id> "..."`                                                         |
| Labels        | `bd label add <id> <label>` / `bd label remove` / `bd label list <id>`          |
| Close         | `bd close <id>`                                                                 |

## Dependencies and structure

- **Blocking edge**: `bd dep add <blocked-id> <blocker-id>` (equivalently
  `bd dep <blocker-id> --blocks <blocked-id>`).
- **Parent / children**: `bd create ... --parent <id>`; `bd children <id>`.
- `bd graph` renders the dependency graph.

## When a skill says "publish to the issue tracker"

Create a bd issue and return its id.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>` and read its comments and notes.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue; tickets are its child issues.

- **Map**: `bd create "Wayfinder: <destination>" -p 1`; keep Notes /
  Decisions-so-far / Fog in its description and notes.
- **Child ticket**: `bd create "<ticket>" --parent <map-id>`; tag the type with
  `bd label add <id> wayfinder:<research|prototype|grilling|task>`.
- **Blocking**: `bd dep add <child> <blocker>`; unblocked when every blocker is
  closed.
- **Frontier**: `bd children <map-id>`, then the first open child with no open
  blocker and no assignee, in map order.
- **Claim**: `bd update <n> --claim`.
- **Resolve**: `bd comment <n> "..."`, `bd close <n>`, then append the decision
  to the map.

## Sync and commit discipline

Issues live in a local Dolt DB; branch-aware sync rides `refs/dolt/data` on the
git remote (`bd dolt push` / `bd dolt pull`). Two files are tracked so a plain
clone can read the tracker: `.beads/issues.jsonl` (the export) and
`.beads/interactions.jsonl` (the audit log). Commit both alongside the work
they describe.

`.beads/config.yaml` enables `export.auto` and `export.git-add`: bd refreshes
the export and stages it for the next commit. Run
`bd export -o .beads/issues.jsonl` if it looks stale.

Database files, locks, and credentials stay local; the nested
`.beads/.gitignore` excludes them.
