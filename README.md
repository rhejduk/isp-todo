# ISP To Do

A private, password protected page. Everything readable is encrypted in the browser with AES-GCM using a key from PBKDF2 (SHA-256, 600,000 iterations). Nothing in this repo is readable without the password.

## Marketing tab: lane filter and people view

- The lane names at the top of the Marketing tab are buttons. Tap one to show only that person's tasks; tap it again or "Show everyone" to reset. The choice is kept per device (prefs key `mktLane`).
- If `data/marketing.json` has `people.<Name>`, tapping that name shows one card grouped by brand: the `people` items (status, due, source, Dash tag) plus any of that person's project card tasks not already listed. Ticks use the same task ids as the project cards.
- `people` is built by `python3 source/curtis_view.py`. A refresh that rewrites `marketing.json` must keep `people` or re-run that script. build.js checks the ids (marketing task ids, or new ids starting with `cv-`).

## Daily To Do: assigned dates

Each Daily task in `data/daily.json` has `assigned_date` (`YYYY-MM-DD`): the date it was added or assigned. Set it once from the earliest date in `sources`, or the date it was first added. Do not change `assigned_date` when updating an existing task.

The Daily tab sorts open tasks **newest assigned date first** within each section (Top priorities, New since last update, Follow-ups, and within each By project group). Project groups stay alphabetical. The sort lives in `src/template.html` (`renderDaily`, `byAssigned`), so later refreshes keep this order without re-sorting the JSON. Each task shows a muted "Assigned Mon D" line under the action.

## Priority and notes

Every task has a Priority dropdown (None, Urgent, High, Medium, Low) and a collapsible Notes box. Both sync across
devices with the checkmarks, keyed by the same stable task ids, so a daily rebuild of the lists does not wipe them.
Priorities highlight the task but do not reorder the list. To read back what is saved, from this repo run
`./read_notes.sh` (see SYNC.md).
