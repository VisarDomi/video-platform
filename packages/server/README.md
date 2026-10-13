# Video Platform Server

This subtree owns the HTTP API, frontend serving, alias refresh, finalization of
recordings handed off through `.pending`, and non-download operational logic.

## API details

- Recordings (`provider` is `tango`, `fc2`, or `sc`), served from the library index
  (`src/services/video/library-index.ts`: in memory and in
  `~/.local/share/video-services/list-index/<provider>.json`, following the folders through
  inotify and a 30 s stat rescan; playlists are read only when their stat changes):
  - `GET /api/videos?provider=` → every recording `{ filename, type, size: 0, duration, isLive }`
    in code-unit order of the filename, encoded once per revision, gzipped, with a revision
    ETag (`304` when unchanged); `&after=<filename>` only the names after it.
  - `GET /api/videos/changes?provider=&epoch=&since=&wait=` → `{ epoch, revision, changes }`
    (each change `{ revision, item }` or `{ revision, removed: { filename, type } }`), waiting
    up to `wait` seconds (at most 25) for the next change when there is none; a client
    without a revision, of another epoch (the server restarted) or too far behind gets
    `{ epoch, revision, videos }` instead. The iPhone local apps keep their list this way.
  - Edits and moves through the API refresh the index before answering.
- Download list endpoints (`provider` is `tango`, `fc2`, or `sc`):
  - `POST /api/{provider}/add` with `{ identifier }`
  - `POST /api/{provider}/remove` with `{ identifier }`
  - `GET /api/{provider}/list`
  - `GET /api/{provider}/member?identifier=` → `{ member }`, by ID: a listed name or ID answers at once; any other name resolves through the provider (Tango: the alias registry, then Tango; Stripchat, which also resolves old usernames; FC2 compares IDs only).
  - `GET /api/{provider}/exists?identifier=` → `{ exists }`: whether the provider itself has a streamer by that name (Tango by current or recent alias, Stripchat by username including old ones, FC2 by channel ID with a non-empty profile). A provider that cannot answer is `502 { error }`, never `exists: false`.
  - `GET /api/{provider}/resolve?identifier=` → `{ id, label }`: read-only resolution with the same logic as add (no list write, no follow); used by the pipeline for provenance.
  - Tango adds unblock the account if it is blocked, then follow it if needed.
- Library maintenance: `POST /api/videos/:filename/repair-playlist` and
  `POST /api/videos/repair-playlists?provider=&scope=all|downloads|edited` run
  PlaylistAuthority duration repair (the bulk form skips `.active` and `.pending`).
