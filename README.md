# video-segment-fetcher
Download 1s .ts files for each of the streamers you follow.

## note
`sharedStatePath: path.join(os.homedir(), ".local", "share", "video-services"),`

this service consumes:

`const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");`

and produces:

`this.statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");`

which gets consumed by both video-stream-builder and video-packager

Note: The Fc2Client.isOnline response does contain the streamer's name (profile_data.name), but we currently discard it and return a boolean. If you ever want human-readable folders for FC2, that is where the change would happen.