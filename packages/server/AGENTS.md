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

## Notes

- The API server has HTTP fallback.
- Userscript integration uses API endpoints to manage download lists.
- Userscripts on external sites should use `GM_xmlhttpRequest` or `GM.xmlHttpRequest` to bypass CORS and mixed-content restrictions.
