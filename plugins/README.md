# Site plug-ins

A site plug-in teaches the core one website: how its download lists read, who is live,
how a stream is opened and what its failures mean. The core owns everything else:
discovery loops, lists, recording folders, polling, segment storage, failover between
copies, stitching, finalization. The plug-in knows the site's protocol, never where the
site runs or what the core does with the answers.

The site plug-ins here are public and neutral, built against the simulated sites in
`packages/simulator`, and they are the reference for writing one:

| | `ts-live` (`plugin-ts-live`) | `ladder-live` (`plugin-ladder-live`) | `fmp4-live` (`plugin-fmp4-live`) |
|---|---|---|---|
| List line | `<accountId> <name>` | `<id> [name]` or `<site>/<id>` | `<name> <id>` (a bare name waits for the server to resolve it) |
| Account | signed in by the auth daemon (`SiteAuth`, below); every request carries its tokens | none | none |
| Who is live | live lookup by account ID, 500 per request; only live + public counts, and only the site's explicit empty answer means nobody | paged channel list; paid or absent = terminal | bulk status, 100 IDs per request; only public + live counts |
| Recording identity | the stream ID | the broadcast's `started_at` | the status's `statusSince` (moves at every status change) |
| Opening a stream | the lookup's master URL; playlists need the ten-second stream tokens | control-channel handshake (long-poll, replies by id) | stream API: name, edges, a master per edge |
| Variant choice | the best resolution (the site lists the lowest first) | best ladder rung within `maxHeight`, at the configured latency | the `source` variant, then by bandwidth |
| Copies | one: no failover | one: no failover | several edges: `edgeOf`, `variantKey`, `recoverVariant` |
| Stream end | ENDLIST, then playlist 404 → `PlaylistNotFoundError` | playlist 403 + channel list says ended → `PlaylistNotFoundError` | playlist 404 + stream API says ended → `PlaylistNotFoundError` |
| Segment handling | ffprobe dimensions (`probeSegmentDimensions`) | ffprobe dimensions (`probeSegmentDimensions`) | zero-size sample repair (`dropZeroSizeSamples`), index check, duration from `sidx` |
| Extras | a 401 run logged once and its end; adding follows the account; hourly name refresh with history; a phone's own token family | numbering restarts pass through to the core | obfuscated playlists (keys from config), renames (durable name history, hourly alias refresh), observe-only access diagnostics |

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
    label: "Australian Open",       // log prefix "[Australian Open] ...", pinned in the plug-in
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

## SiteAuth: accounts

A site that serves only signed-in accounts returns `auth` (a `SiteAuth`) from `create`.
The auth daemon (`packages/auth`) is its only caller for sign-ins and renewals: it signs
in the account the sites file names (`"account"`, with the password from the accounts
file, never the sites file), renews the session and the short-lived tokens on the
plug-in's `intervals`, and saves the bag to the core's credential store after every
change. Capture and catalog never sign in: they read the store on every request
(`ctx.credentials.read()`), so a renewal reaches the next playlist poll without a
restart. `ts-live` is the reference:

- `login(account)` starts a token family; `refreshSession(bag)` rotates the refresh
  token (the presented one is spent, so the daemon saves the renewal before anything
  else uses the bag); `fetchShortTokens(bag, timeoutMs)` trades the session token for
  the stream tokens.
- `classify(error)` is the decision, from typed errors, never from message text: the
  site refused the password → `needs-attention` (automatic sign-ins stop); a client
  error with the site's own error code (a spent, expired or revoked token) →
  `reauthenticate`; the site's device check → `verification`; anything else (a block
  page, a server error, the network) → `outage`, and the tokens stay good.
- `serializeTokens` / `deserializeTokens` define the stored record. Its field names are
  a contract with every reader (`headersFor` builds the request headers from it), so
  they never change without a migration.
- `provisionDevice` / `acknowledgeDevice` (optional) give a phone a token family of its
  own: the PC hands it over once per request ID and keeps none of it.

## Testing

- Unit tests start the simulator in process on ephemeral ports with a manual clock
  (`startSimulator` from `simulator`, see its README) and tiny generated media (ffmpeg
  under `nice`). They build the plug-in through `plugin.create` with a test context, so
  they exercise exactly what the core loads, and move the clock to reach faults.
- `npm run e2e:capture` runs the real downloader against the three live sites, with the
  real auth daemon keeping the account-gated site's session (a revocation of every
  stream token mid-run included), and judges every recording folder with the
  simulator's checker (`packages/simulator/README.md`).

## File hosts

A file host is not a live site: the owner sends one of its file pages from the phone (the
plug-in's browser extension), and the PC copies the original file into a local library.
The core's queue (`packages/server`, `dist/fileHosts.js`) owns the transfer: durable jobs,
resumes only with an identical entity (range + `If-Range` on the same ETag, from the last
fsynced byte), publication without overwriting, and the network guard. A file host plug-in
(`FileHostPlugin` from `sdk`) only knows its pages; `file-host` (`plugin-file-host`) is the
public reference:

- `canonicalPage(url)`: the page a job is known by, or null for anything else.
- `isAllowedHost(url)`: the hosts its pages and downloads may use. The core checks it on
  every request and every redirect hop, and allows HTTPS on the default port only, so
  neither a page nor its metadata can point the PC at the LAN. A deployment whose host is
  not on 443 (the simulator) lists the ports in the sites file entry's `allowPorts`; the
  plug-in cannot widen the guard.
- `resolve(page, http)`: the media URL and its original name, through `http.text` (small
  answers, guarded the same way).
- `jobKey(page)`: 24 hex digits, which the browser extension computes too.

```json
{ "fileHosts": [ { "id": "file-host", "plugin": "plugin-file-host", "allowPorts": [18084, 18085],
    "config": { "origin": "https://127.0.0.1:18084", "downloadHosts": ["127.0.0.1"], "directory": "~/Videos/file-host" } } ] }
```

## Destinations

A destination is where finished recordings are uploaded (`DestinationPlugin` from `sdk`).
The core owns attempts, the byte budget, retries, daily verification, removal bans and
receipt-matched cleanup; the plug-in speaks its site's protocol. Two public references:

| | `form-host` (`plugin-form-host`) | `api-host` (`plugin-api-host`) |
|---|---|---|
| Sign-in | a cookie session from the login form, remember-me | OAuth: a password grant, then a rotating refresh token saved durably before use |
| The video exists | when the metadata form is submitted (`creationBoundary: "metadata_submit"`) | from the create of its resumable upload (`"transfer_start"`) |
| Transfer | chunks under an index, each sent again on failure | byte ranges; after a failure, ask the host where its bytes end and go on from there |
| A failed attempt | before the form: nothing exists, a plain failure | the next attempt asks for the same upload key (`clientRef`) and resumes that video |
| Uploads list | two tabs, paged to a 404, two scans must agree | paged by cursor; the count on the first page must match |
| Refused words | the form answers with them | 422 with the terms |

The rules every destination keeps:

- **Absence needs proof.** `lookup` says `"absent"` only after reading the whole uploads
  list; a page that fails, a count that does not match or a cached answer makes the
  listing inconclusive (throw), never a reason to upload again. A copy is a video that
  holds the file: a failed or unfinished upload is not one.
- **Bytes are recorded before they leave** (`onProgress`), and an upload never sends more
  than its size plus `REQUEST_OVERHEAD_RESERVATION_BYTES`.
- **Failures are typed**: `MetadataRejectedError` (the phrases are learned),
  `HumanActionRequiredError` (a refused password, a daily limit), `ProviderSessionLostError`
  (signed out where the plug-in may not sign in), `UploadTransportError` with
  `acceptanceUnknown` when the destination may hold the file.
- `probe` returns `"online"` only when the best rendition actually answers; `"missing"`
  with `removed: true` only when the complete list lacks the video.

`npm run e2e:pipeline` runs the real pipeline against either (`-- --destination
api-host`): a refused word, every session ended mid-campaign, verification a day later, a
removal that bans the recording from re-upload.

## Content profiles

A content profile decides what a deployment's metadata says about its recordings. It is a
package too, named by the sites file's top-level `"contentProfile"` key, and it exports
`profile` (a `ContentProfilePlugin` from `sdk`):

- `descriptor`: the base prompt file, the model and projector files (under
  `<data root>/models`), the model name sent with each request, and the bounds of the
  model's JSON output. The prompt's exact bytes are its version, which keys every cached
  description, so a profile's prompt changes only together with a plan for the old ones.
- `descriptionFooter(facts)`: the lines under the descriptor's text (for example where and
  when the recording was made). `facts.sourceUrl` is null while a recording's streamer is
  unresolved; such recordings still upload, so the footer says what is unknown.
- `tags(facts)`: every upload's tags; the descriptor's own tags are never used.

The core keeps the rest: the `[<recording folder>]` stamp at the end of every title (the
duplicate guard), shortening to the destination's limits, and learned phrases, which it
stores per destination and adds to the prompt.
