# Video Platform Server

This subtree owns the HTTP API, frontend serving, alias refresh, orphan finalization, and non-download operational logic.

## API details

- Download list endpoints:
  - `POST /api/{provider}/add` with `{ identifier }`
  - `POST /api/{provider}/remove` with `{ identifier }`
  - `GET /api/{provider}/list`
  - `GET /api/{provider}/member?identifier=` → `{ member }`, by ID: a listed name or ID answers at once; any other name resolves through the provider (Tango's alias registry, then Tango; Stripchat, which also resolves old usernames).
  - `GET /api/{provider}/exists?identifier=` → `{ exists }`: whether the provider itself has a streamer by that name (Tango by current or recent alias, Stripchat by username including old ones, FC2 by channel ID with a non-empty profile). A provider that cannot answer is `502 { error }`, never `exists: false`.
  - Tango adds unblock the account if it is blocked, then follow it if needed.
- Tango aliases:
  - `POST /api/tango/add`
  - `POST /api/tango/remove`
  - `GET /api/tango/list`
