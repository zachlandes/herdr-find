# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Node with no dependencies; the picker is stock fzf driven by `herdr-find _key` transforms (`lib/picker.mjs`). `npm test` needs no herdr and no key: `test/support/` stands in for both.
- Everything herdr-find asks herdr goes through `lib/herdr.mjs`; `HERDR_FIND_HERDR` swaps the binary, which is how a named or isolated herdr session is targeted.
- Meaning search is the only thing that sends text off the machine; it must stay behind `meaningStatus` (on, key, mode-600 redaction list) and the redaction sweep in `lib/meaning/search.mjs`. Never print or commit real transcripts: fixtures come from `test/fixtures/build.mjs`.
- Prompt wordings in `lib/meaning/prompts.mjs` are revisioned: add a new entry, never edit an old one, and keep the Needle attribution (see `NOTICE`).
- herdr plugins are registered per user, not per session, so `herdr plugin link` touches the real herdr config; validate the manifest under a throwaway `HOME` instead.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
