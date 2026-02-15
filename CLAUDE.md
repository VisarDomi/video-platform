# Video Editor Frontend

## Project
Svelte 5 SPA for video editing across multiple streaming providers (tl, tango, fc2, sc).

## Workflow
- Time to add changelogs on bug fixes/feature requests
- On task completion:
  1. Update `todo.md` (mark done)
  2. Update `CHANGELOG.md` (log the change with inline decisions)
  3. Commit all changes (use the changelog entry as the commit message)
  4. Move on to the next task

## Build & Restart Policy
- Only build/restart what is necessary, when it is necessary
- If the frontend is served by the backend, a frontend rebuild is sufficient — no backend restart needed
- Avoid unnecessary restarts or full rebuilds when a targeted action suffices

## Changelog & Decisions
- Maintain `CHANGELOG.md` at project root
- Format: date, type (fix/feature/refactor), short description
- Include design decisions inline with each entry (root cause, rationale, files changed)
