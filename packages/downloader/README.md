# video-downloader
Download 1s .ts files for each of the streamers you follow.

## note
`sharedStatePath: path.join(os.homedir(), ".local", "share", "video-services"),`

this service consumes:

`const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");`

and produces:

`this.statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");`

which gets consumed by both video-stream-builder and video-packager

put links of streamers in:
fc2.txt
sc.txt

sudo apt-get install xvfb

