# Triage labels

The engineering skills speak in five canonical triage roles. This file maps each
role to the label string used in this repo's tracker (bd).

| Role              | Label string      | Meaning                                  |
| ----------------- | ----------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation            |
| `wontfix`         | `wontfix`         | Will not be actioned                     |

Apply with `bd label add <id> <label>`; inspect with `bd label list <id>`.

When a skill names a role (for example, "apply the AFK-ready triage label"), use
the matching label string above.
