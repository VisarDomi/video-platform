# How the platform works

A guided tour: one recording from a live stream to a verified upload, then the three ideas
everything else rests on (crash safety, the plug-in boundary, proof before action) and how
each one is tested. Every claim names the code or the command that holds it.

## One recording's journey

```
 live site ──► downloader ──► .pending ──► server finalizer ──► library ──► pipeline ──► destination
   ▲  (plug-in: who is live,     (durable      (integrity check,      (website,   (convert, describe,   (plug-in: upload,
   │   playlists, failover)       segments)     repair, checkpoint)    phone app)  upload, verify)       list, probe)
   └── auth daemon keeps the account signed in (plug-in: SiteAuth) ── credential store ──┘
```

1. **The sites file** (`~/.local/share/video-services/sites.json`) names the live sites, file
   hosts, upload destinations and content profile a deployment uses, each by the package of
   its plug-in and with its own config block. Every service loads the same file through
   `packages/sdk` (`registry.ts`); no service knows a site by name.
2. **The auth daemon** (`packages/auth`) signs in the accounts the sites file names and keeps
   their sessions fresh: a rotating refresh token, the session token, and short-lived
   stream tokens, renewed on the plug-in's intervals. After every change it writes the
   session to the core's credential store durably; it is the only writer. Failures are
   decisions, not strings: the plug-in classifies each one as an outage (keep the tokens),
   a rejected session (sign in again), a verification request, or something only a person
   can fix (stop signing in).
3. **The downloader** (`packages/downloader`) asks each site who is live among the listed
   channels, and records each live stream: it polls the playlist, writes every segment
   durably under `<downloads root>/<site>/downloaded/.active/<folder>/`, switches to
   another copy of the stream when an edge fails, and accounts for every sequence number:
   a segment the site skipped is logged as the site's, one the client missed as its own
   (`SEQUENCE-GAP`). Stream tokens come from the credential store on every request, so a
   renewal reaches the next poll without a restart. When a stream ends, the folder moves
   to `.pending`.
4. **The server's finalizer** (`packages/server`, `mediaIntegrityFinalizer.ts`) watches
   `.pending`, checks every segment, repairs what can be repaired, and publishes the folder
   into the library; a checkpoint per recording (SQLite) lets it resume after a crash. The server also serves the website and its API: lists,
   the viewer, editing, and the download lists (through each site's catalog plug-in).
5. **The pipeline** (`packages/pipeline`) discovers finalized recordings and moves each
   through a state machine in a SQLite ledger: provenance (the channel's pages, from the
   server), conversion, description (a local vision model with the content profile's
   prompt), joining short pieces, upload, and verification a day later. Its campaign
   worker takes one step at a time, under a monthly byte budget. It deletes an original
   only when every upload covering it has been verified online, and keeps the receipts.
6. **The destination plug-in** speaks the upload site's protocol: sign in, transfer, create
   the video, list the account's uploads, and probe one. The core owns everything that
   must not go wrong around it: attempts, reservations, retries, verification, removal
   bans and cleanup.

Single files take a shorter road: a **file host** plug-in knows a file host's pages, and the
core's queue (`dist/fileHosts.js`) copies the original file into a local library, resuming
interrupted transfers only on proof that the entity is the same.

## Crash safety

The platform runs unattended on one PC, so a power cut can come at any instant. The rules:

- **Every durable file write** is a temporary file, fsync, rename, then fsync of the
  directory (`writeFileDurably` in `packages/sdk`). A reader sees the old file or the new
  one, never a torn one.
- **Every ledger change is one SQLite transaction** (WAL, `synchronous=FULL`), the creation
  of a new ledger included.
- **Progress is recorded before it happens**: upload bytes before they leave (so the budget
  never undercounts), the "creating the remote copy now" phase before the request that
  creates it, a file-host transfer's fsynced offset before more bytes are trusted.
- **A restart resumes**, it never repeats: the finalizer from its checkpoint, the pipeline
  from the ledger's state, a file-host transfer from its last fsynced byte, an upload by
  confirming the uncertain attempt before any retry.

The VM harness (`deploy/vm`) checks the rules against real power cuts: it hard-resets a QEMU
guest at random points and checks every invariant after each boot. A journal written by the
rules lost nothing in 160 cuts (130 with QEMU's `writeback` cache, 30 with `unsafe`); the same
journal without the fsyncs lost acknowledged records in 17 of 30 under `writeback`
(`deploy/vm/README.md` has the table and the raw results).

## The plug-in boundary

The core knows no site. `packages/sdk` defines the contracts (live capture, catalog,
sign-in, file host, destination, content profile) and the core reaches plug-ins only through
the sites file. Two tests keep it that way: no core package imports a plug-in or anything
under `private/`, and a plug-in imports only the SDK, Node's built-ins and the dependencies it
declares (`packages/sdk/test/boundaries.test.mjs`).

This repository ships public plug-ins for a **simulator** of every kind of site
(`packages/simulator`): three live sites with different protocols, a file host, a
browser-style form host and an API host. A real deployment keeps its own plug-ins,
configuration and operations in a private repository checked out at `private/`; nothing else
changes.

## Proof before action

The decisions that cost something if they are wrong are taken only on proof:

- **"Absent" needs a complete listing.** Before an upload, the destination's list of
  uploads must be read to the end and agree with the account's own count; a page that fails,
  a cached answer or a count that does not match makes the answer inconclusive, and the
  upload waits.
- **The creation boundary.** A destination declares when the remote copy comes into
  existence: when its metadata form is submitted (form host), or when the transfer starts
  (API host). A failure before it is a plain failure; after it, the attempt is uncertain
  and confirmed against the list before anything is sent again.
- **Removed means never again.** A copy the destination removed (gone from its complete
  list) is recorded at once, and that recording is never uploaded there again.
- **A null lookup is no answer.** When a live site cannot say who is live, the downloader
  keeps every capture running; only the site's explicit "nobody" ends one.
- **The network guard.** The file-host queue contacts only the hosts the plug-in names, over
  HTTPS on the default port, on every request and every redirect hop; a page that redirects
  to the cloud metadata address is refused. Other ports need the operator's own setting.

## How it is tested

| What | Command | Proves |
|---|---|---|
| Unit and contract tests | `npm test -w sdk`, `npm test -w pipeline`, `npm run test:sim-plugins` | each package and plug-in on its own |
| Capture | `npm run e2e:capture` | the real downloader and auth daemon against three simulated live sites with outages, skips, restarts, edge failover, damaged segments, renames and a token revocation; every recording judged byte for byte against the simulator's ground-truth log |
| Pipeline | `npm run e2e:pipeline` (`-- --destination api-host`) | the real pipeline from finalized recordings to verified uploads: a refused word learned, sessions ended mid-campaign, a removal banned |
| File host | `npm run e2e:file-host` | the queue service against the simulated file host: an off-site redirect refused, a dropped transfer resumed, the service killed mid-transfer and resumed from fsynced bytes |
| Power cuts | `deploy/vm/harness run` | the durability rules under real resets |
| Everything at once | `npm run demo` | the whole platform in a Podman pod against the simulator |

The simulator logs everything it served (`truth.jsonl`), and its checker compares a
recording folder with that log: every segment exact, every miss and skip accounted for, so
an end-to-end run is judged by evidence, not by its own logs.

## Read next

- [Engineering stories](STORIES.md): things that broke, how they were found, and the test
  that holds each fix.
- The decisions behind each package: `packages/*/decisions.md`.
- Writing a plug-in: [`plugins/README.md`](../plugins/README.md).
- The simulator and its scenarios: [`packages/simulator/README.md`](../packages/simulator/README.md).
