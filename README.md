# ISP To Do

A private, password protected page. Everything readable is encrypted in the browser with AES-GCM using a key from PBKDF2 (SHA-256, 600,000 iterations). Nothing in this repo is readable without the password.

## Marketing tab: lane filter and people view

- The lane names at the top of the Marketing tab are buttons. Tap one to show only that person's tasks; tap it again or "Show everyone" to reset. The choice is kept per device (prefs key `mktLane`).
- If `data/marketing.json` has `people.<Name>`, tapping that name shows one card grouped by brand: the `people` items (status, due, source, Dash tag) plus any of that person's project card tasks not already listed. Ticks use the same task ids as the project cards.
- `people` is built by `python3 source/curtis_view.py`. A refresh that rewrites `marketing.json` must keep `people` or re-run that script. build.js checks the ids (marketing task ids, or new ids starting with `cv-`).
