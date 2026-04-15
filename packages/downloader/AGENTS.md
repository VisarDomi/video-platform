# Video Platform Downloader

This subtree owns stream discovery, capture, disk sessions, and target-file watching.

## Target files

- `fc2.txt`
- `sc.txt`
- `tango.txt`

These live in this package directory and are watched by the downloader services.

## Rule

- Keep downloader concerns separate from server/API concerns.
