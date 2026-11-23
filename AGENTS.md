# Video platform: rules for agents

If `private/` is checked out, read and follow `private/AGENTS.md` first: it holds the
deployment's own rules, which come on top of these.

- **The core knows no site.** Code under `packages/` imports only the SDK and its own
  packages, never a plug-in (`packages/sdk/test/boundaries.test.mjs`). Anything about one
  site's URLs, APIs, naming or quirks belongs in its plug-in; anything about the protocol
  or the core's promises (no lost media, honest gap accounting, durability, the budget)
  belongs in the core.
- **No real site names outside `private/`.** Public code, tests, fixtures and docs use the
  simulated sites and neutral IDs.
- **Power-cut robust, or it is a bug.** Durable writes go through `writeFileDurably`;
  ledger changes are single transactions; a restart resumes, it never redoes or skips.
- **Production runs from this checkout.** Behaviour changes are deliberate and tested;
  deploying is an explicit build (sdk, shared, plug-ins, then the packages), never a side
  effect of a restart. Never rebuild the pipeline's build while its worker runs.
- **Browsers:** the system Chromium only, with its sandbox for anything that opens a live
  website (`packages/sdk/test/systemBrowsers.test.mjs`).
- **Current state only.** Docs and comments describe the current behavior only; history
  lives in git and in `docs/STORIES.md`.
- Work in a git worktree; leave other sessions' edits and processes alone.
