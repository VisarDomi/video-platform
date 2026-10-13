# Video Platform Downloader

This subtree owns stream discovery, capture, disk sessions, and target-file watching.

## Target files

`fc2.txt`, `sc.txt` and `tango.txt` are the download lists in
`~/.local/share/video-services/download-lists/` (`downloadListPath` in `packages/shared`;
`VIDEO_SERVICES_DATA_ROOT` overrides the data root), outside the repository. The
downloader watches them; the server edits them.

## Storage

Recordings are captured under `<downloads root>/<provider>/downloaded/.active/` and
handed to the server through `downloaded/.pending/` (see `decisions.md`). The downloads
root is `~/Videos/downloads` (`downloadsRoot` in `packages/shared`; `VIDEO_DOWNLOADS_ROOT`
overrides it).
