# tslive-segment-fetcher
Download 1s .ts files for each of the streamers you follow from tslive.

## note
```
sharedStatePath: path.join(os.homedir(), ".local", "share", "tslive-services"),
```

this service consumes:

`const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");`

and produces:

`this.statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");`

which gets consumed by both tslive-stream-builder and tslive-packager
