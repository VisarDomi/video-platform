# tango-segment-fetcher
Download 1s .ts files for each of the streamers you follow from tango.

## note
```
sharedStatePath: path.join(os.homedir(), ".local", "share", "tango-services"),
```

this service consumes:

`const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");`

and produces:

`this.statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");`

which gets consumed by both tango-stream-builder and tango-packager
