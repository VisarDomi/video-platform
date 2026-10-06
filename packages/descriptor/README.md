# Descriptor engine

This package contains the local native-video descriptor engine and a manual
single-artifact command. The pipeline calls its `describeArtifact()` and
`rewriteAvoidingPhrases()` library entry points; the descriptor is neither the
durable job owner nor a standalone daemon.

Managed startup allows up to ten minutes for a slow model load, configurable
with `DESCRIPTOR_STARTUP_TIMEOUT_MS`. Each health request is bounded to two
seconds; startup logs progress every thirty seconds and includes recent model
logs on failure. Exited/signalled children and missing executables fail promptly.
Failed starts clean up their child; shutdown sends SIGTERM and kills the child
after ten seconds. An already-occupied health endpoint is refused in managed
mode. Set `DESCRIPTOR_MODEL_URL` only when intentionally using an external
server; the descriptor then waits for its health endpoint instead of launching
one.

The manual command accepts a remuxed media file (not an HLS playlist or
directory), probes its duration, chooses a sampling rate that fits the
configured video-token budget, and sends the file to the pinned local llama.cpp
fork through an OpenAI-compatible `input_video` request. The file is staged as
a symlink in the runtime's media directory (`--media-path`) and referenced as
`file://<name>`. Evidence is written beneath
`~/.local/share/video-services/pipeline/descriptions/`: `manual/` for the
command, `artifacts/<artifact SHA-256>/<prompt version>[-clockwise]/` for the
pipeline, which reuses a matching result instead of describing again.

`describeArtifact()` options:

- `rotation: "clockwise"`: the artifact was turned 90° counterclockwise for
  upload (the pipeline's `-ccw` artifacts); the model is shown an upright copy
  turned back with `transpose=1`, encoded at the descriptor's maximum FPS. The
  rotation is part of the evidence identity.
- `avoidPhrases`: phrases an upload provider refused; they are appended to the
  prompt and change the prompt version.

`rewriteAvoidingPhrases()` asks the same model, text only, to rewrite an
existing title and description without the given phrases.

Install and activate the exact runtime pinned in
`runtime/llama-cpp.lock.json`:

```bash
npm run runtime:install -w descriptor
```

For development, build and activate a local llama.cpp checkout (a dirty tree
gets a fingerprinted runtime ID):

```bash
npm run runtime:install -w descriptor -- \
  --source /path/to/llama.cpp \
  --jobs 6
```

Runtime builds default to one job per available logical CPU; `--jobs`
overrides it and `--no-activate` builds without activating. The installer sets
`CCACHE_BASEDIR` to the selected source root so clean checkouts can reuse
compiled objects. `npm run runtime:activate -w descriptor -- <runtime-id>`
switches to an already installed runtime.

Describe one remuxed media file:

```bash
npm run describe-one -w descriptor -- "/path/to/video.mp4"
```

For long or production-sized inputs, run the bounded form:

```bash
npm run describe-one:bounded -w descriptor -- "/path/to/video.mp4"
```

It runs the descriptor in a transient user scope inside
`video-processing.slice`, which caps all processing work together at
`CPUQuota=600%`, starts memory reclaim at 70% of physical RAM, hard-limits it at
80%, and denies swap (see `systemd/README.md`). Exceeding the memory ceiling
terminates work in the slice rather than exhausting host RAM and swap.

Relevant tuning variables:

- `DESCRIPTOR_MAX_FPS` (default `4`; duration tiers and the token budget may lower it)
- `DESCRIPTOR_VIDEO_TOKEN_BUDGET` (default `115000`)
- `DESCRIPTOR_TOKENS_PER_FRAME` (default `70.5`)
- `DESCRIPTOR_STARTUP_TIMEOUT_MS` (default `600000`)
- `DESCRIPTOR_MODEL_URL` (external server) or `DESCRIPTOR_MODEL_PORT` (managed, default `7976`)
- `DESCRIPTOR_LLAMA_SERVER`, `DESCRIPTOR_MODEL_PATH`, `DESCRIPTOR_MMPROJ_PATH`,
  `DESCRIPTOR_TEMPLATE_PATH`, `DESCRIPTOR_PROMPT_PATH`, `DESCRIPTOR_MEDIA_PATH`
- `VIDEO_SERVICES_DATA_ROOT` (default `~/.local/share/video-services`) for the
  runtime, model, media, and evidence locations

The direct Gemma 4 template (`gemma4-direct.jinja`) is intentional. The GGUF
embeds a thinking/tool template that can leave the reasoning channel open during
schema-constrained requests. Descriptor output needs neither reasoning nor
tools, so the minimal template preserves the required turn and media tokens
while allowing llama.cpp to enforce JSON from the first generated token.

The duration policy uses up to 4 FPS below seven minutes, up to 2 FPS from seven
to below fifteen minutes, and up to 1 FPS thereafter. The token budget remains
authoritative inside every tier, so full 4 FPS fits through approximately 6:48,
full 2 FPS through 13:36, and full 1 FPS through 27:11.

Longer videos keep roughly 1,631 sampled frames: 0.453 FPS at one hour and
0.2266 FPS (one frame every 4.41 seconds) at two hours. Transfer scheduling
controls resource duty while FPS controls evidence quality and context fit.
Measurements behind these settings are in `MODEL.md`.
