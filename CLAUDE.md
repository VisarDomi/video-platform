# Video Editor Frontend

## Project
Svelte 5 SPA for video editing across multiple streaming providers (tl, tango, fc2, sc).

## Required Reading
- **TL Provider**: Read `TL_PROVIDER.md` before any TL provider work (architecture, source of truth hierarchy, removal rules)
- **HLS Proxy**: Read `docs/tl-hls-proxy.md` for proxy architecture and past debugging lessons

## Workflow
- Time to add changelogs on bug fixes/feature requests
- On task completion:
  1. Update `todo.md` (mark done)
  2. Update `CHANGELOG.md` (log the change with inline decisions)
  3. Commit all changes (use the changelog entry as the commit message)
  4. Move on to the next task

## Changelog & Decisions
- Maintain `CHANGELOG.md` at project root
- Format: date, type (fix/feature/refactor), short description
- Include design decisions inline with each entry (root cause, rationale, files changed)
