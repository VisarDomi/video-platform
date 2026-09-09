# V3 launch preflight — September 9, 2026

Scope: readiness for the operator-selected comparison trial, not approval for
unrestricted production or a certificate that provider encoding preserves quality.
No trial uploads or full selected-recording conversions were started by preflight.

Result: no known pre-launch blocker remains for this selected trial. Regression
tests passed: pipeline 95/95, downloader 29/29, descriptor 9/9 (133 total).
Machine-readable results and selected-source fingerprints are saved alongside
this report in `v3-launch-preflight-2026-09-09.json`.

## Selection and authority

- Selection: `/home/visar/.local/share/video-services/pipeline/test-videos.txt`.
- Selection SHA-256: `3c501047703daf56ebc17aa513723e5d5dad8b9fbb4d0d19931f68e750c081e2`.
- 22 unique recordings: Tango 4, FC2 4, SC 14; all 20 listed E-cases represented.
- All 22 have exact ready validation checkpoints, finalized playlists, referenced
  media present, safe local paths, and resolved provider/source identities.
- 27,257 selected segments; 44,483.449 seconds of source material.
- Selected-only dimension analysis confirmed 17 whole conversions, 2 native
  remuxes, and 3 retained-high-quality remuxes. No catalog revalidation occurred.
- Expected playlist-duration sum after intentional omissions: 44,056.489 seconds.
  The three retained remuxes omit 426.960 seconds total. All conversions retain
  every selected source segment. These durations are not frame-equivalence proof.

| Case | Selected recording(s) | Confirmed route |
|---|---|---|
| E01 | 2025-10-02 183803 kaaysi | Whole conversion |
| E02 | 2025-10-07 184656 princess-irina | Whole conversion; no policy drops |
| E03 | 2025-10-03 233108 rabbit146 | Convert both 360p opening and 720p remainder |
| E04 | 2025-10-02 141119 mmarianna | Convert untagged mixed dimensions |
| E05 | 2026-01-27 130031 8175021; 2026-01-25 153803 1179794 | Whole conversion, custom aspect |
| E06 | 2026-01-25 153250 1179794 | Whole conversion in playlist order |
| E07 | 2026-01-23 150039 12830257 | Whole conversion, segment-owned dimensions |
| E08 | 2026-03-20 120730 Hanna_18_cute | Whole conversion |
| E09 | 2026-03-20 065117 Minami_jjjj | Whole conversion across same-size init changes |
| E10 | 2026-03-19 164548 _YURIYURI_ | Whole 480p conversion, 4:3 |
| E11 | 2026-03-20 123952 _YURIYURI_ | Whole conversion across repeated short init runs |
| E12 | 2026-03-18 161011 AI_channel | Native remux |
| E13 | 2026-03-20 120646 LOVE_MIREI_LOVE | Native remux across init changes |
| E14 | 2026-04-24 164513 Yukinyan_xoxo; 2026-03-20 222452 akaneppi_ | Retained remux: 95.300% / 92.951% qualifying duration |
| E15 | 2026-06-29 143246 akaneppi_ | Retained remux: 96.995%, multiple cuts |
| E16 | 2026-05-02 084606 Yukinyan_xoxo | Whole conversion: 87.705% qualifying duration |
| E17 | 2026-06-15 115702 kanata_mu_ch | Whole conversion, long 480p opening |
| E18 | 2026-06-01 180624 kanata_mu_ch | Whole conversion, repeated resolution changes |
| E19 | 2026-07-28 184346 RIN_RIN__ | Whole conversion, tiny native prefix |
| E20 | 2026-08-04 172611 baby__cherry__ | Whole conversion, nonstandard widescreen |

## Why earlier runs were insufficient

| Earlier concern | V3 protection / acceptance check |
|---|---|
| Original remux-only uploads lost quality in provider re-encoding; some were delivered at unexpectedly low resolution | Exact pixel-area/duration routing; original/local/provider visual comparison still required |
| Broad oldest-first trial did not use an operator-selected edge-case list | Only this file supplies candidates; exhaustion does not discover the catalog |
| Irina's content near 1572.ts could not be found in uploaded playback | Irina retained in E02; no source content may be omitted on its conversion branch; compare both sides of the edit |
| Local v2 artifacts disappeared after verification, preventing diagnosis | Comparison artifacts retained regardless of cleanup flag, identity guard or missing-source sweep; missing artifact prevents successful completion |
| Tagged/untagged resolution and init changes could lose content | Segment-owned analysis and independent temporary input runs; generated frame-ID, timing and AAC tests; E02/E04/E09/E11/E18 real coverage |
| Trial admission counted work that did not become successful uploads | Failed/blocked entries pause for attention, do not get substitutes or count as a complete comparison; remote verification remains distinct from human quality approval |
| Test/version labels cluttered public titles | Prepared comparison trial keeps diagnostics; normal campaign titles are clean; verification uses provider IDs |

## Descriptor preflight

Eight v2 records failed at the old 120-second model-readiness deadline. Logs show
model loading began, but do not establish why those particular loads stalled.
Today the same installed runtime started in 13.151 seconds in a bounded scope.

Startup hardening now allows ten minutes, bounds health requests, reports progress
and child errors with recent logs, cleans up failed starts, and refuses to adopt
an unrelated health endpoint. Model, context size, inference sampling policy and
resource limits are unchanged. No descriptor daemon was created.

Real inference on a generated two-second MP4 succeeded twice across a full
shutdown/restart, under `video-processing.slice`. The final two runs took 19.283
and 8.524 seconds, including model startup and inference. This checks actual
runtime, model files, local-media loading, response JSON and process cleanup; it does not
prove every long-video inference will succeed or every generated title is good.
Failure remains visible and pauses the comparison rather than silently skipping it.

## Operational checks

- Authenticated uploads page returned HTTP 200 using the campaign browser profile;
  the preflight performed no upload or metadata edit.
- Server and virtual display are active; installed systemd files match the repo.
- Approximately 1.6 TiB available for retained comparison artifacts.
- Monthly upload ledger preserves v2's 36.253 GB usage against a 600 GB allowance.
  Provider-side daily limits can still add cooldowns and cannot be promised away.
- Database integrity check passed. The transfer-start safety migration is applied.
- Pre-migration backup:
  `/home/visar/.local/share/video-services/pipeline/history/production-v3/preflight-2026-09-09T09-42-32.083Z.sqlite`.
- Pipeline remains paused, worker stopped, no recordings admitted. The selected
  file was not ingested or modified during these checks.

## Launch and pass criteria

On explicit launch approval, reread the file, queue its valid paths, then resume
and start the comparison worker. Additions are appended; pending removals cancel;
already attempted/processed items remain preserved. No old upload-history reset.

Completion requires all selected recordings to be verified online with their local
artifacts still present. Then the operator compares original, retained artifact and
provider playback: opening/ending, motion, transition content, aspect/orientation,
no added crop/padding, audio sync, source identity and meaningful titles/descriptions.

Exact thresholds, higher/custom native geometry, prefix/suffix omissions and crash
recovery also have synthetic regression coverage because this real selection does
not represent every possible format or failure. Unusual codecs, within-segment
changes, changed aspect/rotation and provider transcoding behavior are not universally
certified. Three days is a planning estimate, not a completion guarantee. Passing
the comparison does not automatically authorize unrestricted catalog processing.
