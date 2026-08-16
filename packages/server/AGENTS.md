# Video Platform Server

This subtree owns the HTTP API, frontend serving, alias refresh, orphan finalization, and non-download operational logic.

## API details

- Download list endpoints:
  - `POST /api/{provider}/add` with `{ identifier }`
  - `POST /api/{provider}/remove` with `{ identifier }`
  - `GET /api/{provider}/list`
- Tango aliases:
  - `POST /api/tango/add`
  - `POST /api/tango/remove`
  - `GET /api/tango/list`
