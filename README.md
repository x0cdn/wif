# wif — What I Follow

A userscript for Greasemonkey/Tampermonkey that shows public repositories and their short descriptions next to every user on GitHub's `following` tab.

- Your own repositories are always displayed first.
- Followed users are shown as responsive cards in two columns (one column on narrow screens).
- Each followed user's card shows up to two repositories; the rest are hidden behind a "Show more" link.
- New followed users are handled automatically, without reloading the page.

## Installation

Open [following-repos.user.js](https://raw.githubusercontent.com/x0cdn/wif/main/following-repos.user.js) — Greasemonkey will offer to install the script. The same URL is used for updates (`@downloadURL` / `@updateURL`).
