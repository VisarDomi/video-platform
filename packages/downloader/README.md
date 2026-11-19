# Video Platform Downloader

This subtree owns stream discovery, capture, disk sessions, and target-file watching. It
knows no site: each site is a plug-in package (`sdk`'s `SitePlugin`) that supplies a
catalog (the download-list line format) and a live capture (who is live, playlists,
segments). The core owns the discovery loop, the session rules, durability and handoff.

## Sites file

The sites to capture come from the sites file: `$VIDEO_SITES_FILE`, else
`<services data root>/sites.json` (`{"sites": [{"id", "plugin"}]}`, see
`packages/sdk/src/registry.ts`). A missing or invalid file, or one without a capture site,
stops the service at startup. The site ID names the download list and the recording
folders; the plug-in's label is the log prefix (`[<label>] ...`). Each plug-in gets its own
state directory, `<services data root>/site-state/<id>/`.

## Target files

Each site's download list is `<id>.txt` in `~/.local/share/video-services/download-lists/`
(`downloadListPath` in `packages/shared`; `VIDEO_SERVICES_DATA_ROOT` overrides the data
root), outside the repository, read with the site's catalog. The downloader watches them;
the server edits them.

## Storage

Recordings are captured under `<downloads root>/<provider>/downloaded/.active/` and
handed to the server through `downloaded/.pending/` (see `decisions.md`). The downloads
root is `~/Videos/downloads` (`downloadsRoot` in `packages/shared`; `VIDEO_DOWNLOADS_ROOT`
overrides it).
