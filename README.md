# tango-segment-fetcher
Download 1s .ts files for each of the streamers you follow from tango.

## note
this service depends on the tokens of this location

`const sessionFilePath = path.resolve(cfg.sharedStatePath, "session.json");`

and creates this communication file:

`this.statusFilePath = path.join(cfg.sharedStatePath, "live-status.json");`

```
sharedStatePath: path.join(os.homedir(), ".local", "share", "tango-services"),
```

and is coupled to tango-packager with this setting:

```
config.getConfig().timeouts.staleStream
```
