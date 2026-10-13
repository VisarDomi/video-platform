# What

A full video pipeline that saves the list of streamers to download, downloads their streams (local backup), views the downloads, edits the downloads, converts the edited videos, describes them, uploads them (online backup)

# Why

This project started out as a simple downloader, then it crept on scope until a full pipeline was developed. 

# How

One provider I implemented myself, the other two are inspired by other github repos. This repo has gone through a lot of changes since the first provider. So it saves all the 1second .ts files of a stream in a folder. From the ui you can then either view it using apple's mpegts requirements, because safari apple is very strict on metadata and format of the stream. So the download and server try to keep the best playlist.m3u8 possible so that it's playable on safari ios. So discontinuities and changes of quality are present in the playlist in the appropriate place. Streamers can be added to the download lists straight from the providers' sites on the phone, without needing to use a pc: the +/- button in the iPhone apps and the FC2 live and SC live Safari extensions (hosted by the Tango app) edit the provider .txt files. The provider I implemented uses google oauth, so i have a playwright backup to login automatically using google by using xvfb of linux to load the chrome headful on memory, so that it bypasses the usual bot checks. This is not useful when scraping a lot, but it's useful for low impact actions you would usually do manually and rarely. The UI has swipe gestures to make navigation feel polished. On the iPhone, five apps (Tango local, FC2 local, SC local, Video Vault and Tango) play the videos in a native player that keeps playing through lock and the background.

# setup
[setup notes](./notes.md)

# Docs

Start with [AGENTS.md](./AGENTS.md). Every doc in the repository:

- [AGENTS.md](./AGENTS.md): ownership, and where to start.
- [notes.md](./notes.md): setup: packages, services, logs, data outside the repository, download lists.
- [decisions.md](./decisions.md): the system's rules and why: components, recording lifecycle, conversion and upload policy, operations.
- [issues.md](./issues.md): open issues (HTTP caching).
- [apps/ios/README.md](./apps/ios/README.md): the five iPhone apps: behaviour, rules, build, deploy, tests, frame reports, renewal. (`apps/tango` holds only the Tango unblock script it describes.)
- [packages/app/README.md](./packages/app/README.md), [decisions.md](./packages/app/decisions.md): the website (lists, viewer, edits) and its WebKit tests.
- [packages/auth/decisions.md](./packages/auth/decisions.md), [SESSION-RECOVERY.md](./packages/auth/SESSION-RECOVERY.md): the PC's Tango session and how to recover it.
- [packages/descriptor/setup.md](./packages/descriptor/setup.md), [MODEL.md](./packages/descriptor/MODEL.md): the local description model, its runtime and the measurements behind its settings.
- [packages/downloader/README.md](./packages/downloader/README.md), [decisions.md](./packages/downloader/decisions.md): stream capture.
- [packages/live-extensions/README.md](./packages/live-extensions/README.md): the FC2 live and SC live Safari extensions.
- [packages/pipeline/setup.md](./packages/pipeline/setup.md), [docs/upload-recovery.md](./packages/pipeline/docs/upload-recovery.md): conversion, description, upload and verification; upload recovery.
- [packages/server/README.md](./packages/server/README.md), [decisions.md](./packages/server/decisions.md): the API, finalization and download lists.
- [packages/shared/decisions.md](./packages/shared/decisions.md): storage layout, token reader, logging.
- [systemd/setup.md](./systemd/setup.md): the user units and their resource limits.

Outside the repository: the [NativeKit guide](../../ios-tools/native/README.md) (shared iPhone code and rules), [Mac and phone access](../../../environment/mac-access.md), [renewal](../../ios-tools/renewal/README.md).

Earlier docs (the iPhone port log, the web-era Tango app docs, pipeline launch reports) are in git history; the last commit before this layout is `817cd7f`.
