# Site plug-ins

A site plug-in teaches the core one website: how its download lists read, who is live,
how a stream is opened and what its failures mean. The core owns everything else:
discovery loops, lists, recording folders, polling, segment storage, failover between
copies, stitching, finalization. The plug-in knows the site's protocol, never where the
site runs or what the core does with the answers.

The two plug-ins here are public and neutral, built against the simulated sites in
`packages/simulator`, and they are the reference for writing one:

| | `ladder-live` (`plugin-ladder-live`) | `fmp4-live` (`plugin-fmp4-live`) |
|---|---|---|
| List line | `<id> [name]` or `<site>/<id>` | `<name> <id>` (a bare name waits for the server to resolve it) |
| Who is live | paged channel list; paid or absent = terminal | bulk status, 100 IDs per request; only public + live counts |
| Recording identity | the broadcast's `started_at` | the status's `statusSince` (moves at every status change) |
| Opening a stream | control-channel handshake (long-poll, replies by id) | stream API: name, edges, a master per edge |
| Variant choice | best ladder rung within `maxHeight`, at the configured latency | the `source` variant, then by bandwidth |
| Copies | one: no failover | several edges: `edgeOf`, `variantKey`, `recoverVariant` |
| Stream end | playlist 403 + channel list says ended → `PlaylistNotFoundError` | playlist 404 + stream API says ended → `PlaylistNotFoundError` |
| Segment handling | ffprobe dimensions (`probeSegmentDimensions`) | zero-size sample repair (`dropZeroSizeSamples`), index check, duration from `sidx` |
| Extras | numbering restarts pass through to the core | obfuscated playlists (keys from config), renames (durable name history, hourly alias refresh), observe-only access diagnostics |

## The package

```
plugins/<name>/
  package.json      name plugin-<name>; dependencies: sdk (+ declared runtime deps);
                    devDependencies: simulator, typescript
  tsconfig.json     ESNext modules, strict, src -> dist (as the private plug-ins)
  src/index.ts      export const plugin: SitePlugin (and default)
  src/config.ts     readConfig(ctx.config): validated, with defaults
  src/catalog.ts    Catalog
  src/capture.ts    LiveCapture
  src/provider.ts   IStreamProvider and its IDownloadSession
  src/api.ts        the site's own API (fetch + requestSignal)
  test/*.test.mjs   against the simulator, in process
```

A source file imports only `sdk`, `node:*` built-ins, its own files and the runtime
dependencies its `package.json` declares; `packages/sdk/test/boundaries.test.mjs`
enforces it for `plugins/*` and `private/plugins/*`, and no core package may import a
plug-in. Public plug-ins carry no real site names or hosts (the leak grep in the brief).

New workspace packages are wired by hand (never `npm install`): the root `workspaces`
entry, a `node_modules/plugin-<name>` symlink to the package, and minimal
`package-lock.json` entries in the existing format. `npm run build:sim-plugins` builds
both; `npm run test:sim-plugins` tests them.

## The entry point

```ts
export const plugin: SitePlugin = {
    id: "fmp4-live",                // the plug-in type
    label: "fMP4 Live",             // log prefix "[fMP4 Live] ...", pinned in the plug-in
    sdkVersion: SDK_VERSION,        // the core refuses another SDK version
    create(context) {               // once per site in the sites file
        const config = readConfig(context.config);
        ...
        return { catalog, capture, init: () => names.load() };
    },
};
```

The sites file names the site, the package and its config; every host, port, key and
timing comes from there (`ctx.config`), so the same plug-in runs against the simulator
and anywhere else:

```json
{ "sites": [
  { "id": "fmp4-live", "plugin": "plugin-fmp4-live",
    "config": { "baseUrl": "http://127.0.0.1:18083", "playlistKeys": { "k1": "<secret>" }, "pollIntervalMs": 5000 } }
] }
```

`ctx` also gives a crash-safe key-value store (`ctx.store`, durable when a write
resolves; fmp4-live keeps its name history there), the site's paths, a logger whose lines
carry the label, a clock, and the site account's stored credentials (`ctx.credentials`,
for sites with auth). `readConfig` throws on a bad value: a broken sites file stops the
start instead of capturing wrongly.

## Catalog: lists and identity

- `parseTargetLine(line, warn?)` is the one parser of a list line, shared by every
  reader: comments and blanks give null; a malformed line gives null and a note to
  `warn` when the reader passes one; nothing else happens. `formatTargetLine` writes a
  line back; the format is pinned (other programs read the lists), so the two
  round-trip.
- A target is `{id, label}`: the ID is what the site knows the channel by, the label
  names recording folders. `listChangesBy: "entry"` when a rename should log as one
  removed and one added entry (fmp4-live).
- Server side: `resolveIdentifier` (an ID, name or page URL, through the site; null when
  the site has no such channel, a throw when it cannot say), `exists`,
  `resolveForRemove(identifier, listed)` (names, old ones too, map to the listed key),
  `sourceLinks` (`{channelUrl, aliasUrl}`) and `refreshAliases` (the core runs it on its
  interval and rewrites the list with the current names).

## LiveCapture: who is live

- `lookup(targets, running)` returns a `ProviderSnapshot`: `live` (target → alias,
  recording identity), `terminalTargetIds` (definitely not recordable: offline, paid,
  private), optionally `unidentifiedTargetIds` and `startOrder`. **null means "the site
  could not answer"**, never "everybody is offline": the core then keeps every capture
  and decides nothing. No listed target with an ID: return null without a request.
- The recording identity decides whether a live channel is the same recording or a new
  one; take the site's own start or status-change stamp, normalized
  (`normalizeRecordingId`).
- `resolveMaster(live)` runs only for a capture about to start: expensive steps
  (a handshake, the stream API) belong here, not in `lookup`.
- `pollIntervalMs` with `pollFromStart` (start to start) or without (end to start),
  `mediaFormat` (`ts` or `fmp4`), and `targetIdForFolderAlias` when a folder may carry a
  name the list no longer has (renames).

## IStreamProvider: the stream

- `parseMasterPlaylist(url)` gives the variant to capture (null when the master is
  unavailable); `describeVariant` says what was chosen for the log lines.
- `createDownloadSession()` gives a session the core polls with:
  - `fetchPlaylist(url, signal)`: the playlist text (decoded, if the site obfuscates it),
    or null with `getLastPlaylistFailure()` saying why (`http` + status, `network`,
    `decrypt`). Throw `PlaylistNotFoundError` only when the site confirms the stream
    ended; the recording then ends at once.
  - `fetchSegment(url, signal)`: `{data}` (optionally `repair`, logged by the core), or
    `{data: null, retryable, status}`. Retryable failures are retried in place while the
    window lists the segment; a non-retryable one ends the attempt and the core asks
    `shouldRetry`.
- `validateSegment(path)` judges a written file (valid, dimensions, accurate duration);
  an invalid one is refetched, never deleted.
- Copies (several CDN edges): `edgeOf(url)` names a URL's copy, `variantKey(url)` names
  the rendition whatever copy serves it, `recoverVariant(master)` finds another copy when
  the current one fails (fmp4-live: healthiest edge first, from its own failure memory).
  Switching, deduplication by program date-time and gap accounting are the core's, in
  both paths: failover within an attempt and a new attempt that starts on another copy.
- `shouldRetry(context)`: after an attempt ended without the stream ending, the master
  to start again from (the same broadcast, re-opened), the previous URL to keep waiting
  for the core's offline confirmation, or null to stop.
- `diagnoseAccessFailure` (optional) gathers evidence when an access incident opens. It
  is observe-only: it runs beside capture with short timeouts and changes nothing
  (fmp4-live probes every edge without recording an edge failure).

## Testing

- Unit tests start the simulator in process on ephemeral ports with a manual clock
  (`startSimulator` from `simulator`, see its README) and tiny generated media (ffmpeg
  under `nice`). They build the plug-in through `plugin.create` with a test context, so
  they exercise exactly what the core loads, and move the clock to reach faults.
- `npm run e2e:capture` runs the real downloader against both sites and judges every
  recording folder with the simulator's checker (`packages/simulator/README.md`).

## Content profiles

A content profile decides what a deployment's metadata says about its recordings. It is a
package too, named by the sites file's top-level `"contentProfile"` key, and it exports
`profile` (a `ContentProfilePlugin` from `sdk`):

- `descriptor`: the base prompt file, the model and projector files (under
  `<data root>/models`), the model name sent with each request, and the bounds of the
  model's JSON output. The prompt's exact bytes are its version, which keys every cached
  description, so a profile's prompt changes only together with a plan for the old ones.
- `descriptionFooter(facts)`: the lines under the descriptor's text (for example where and
  when the recording was made). `facts.sourceUrl` is null while a recording's provenance is
  unresolved.
- `tags(facts)`: every upload's tags; the descriptor's own tags are never used.

The core keeps the rest: the `[<recording folder>]` stamp at the end of every title (the
duplicate guard), shortening to the destination's limits, and learned phrases, which it
stores per destination and adds to the prompt.
