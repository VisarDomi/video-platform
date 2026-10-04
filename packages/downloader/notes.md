# Video Platform Downloader

This subtree owns stream discovery, capture, disk sessions, and target-file watching.

## Target files

`fc2.txt`, `sc.txt` and `tango.txt` are the download lists in
`~/.local/share/video-services/download-lists/` (`downloadListPath` in `packages/shared`),
outside the repository. The downloader watches them; the server edits them.
