# Descriptor prototype

This package contains the local native-video descriptor smoke test. It is not
yet the production worker or job owner.

The smoke test accepts a remuxed media file, probes its duration, chooses a
sampling rate that fits the configured video-token budget, and sends the file
to the pinned local llama.cpp fork through an OpenAI-compatible
`input_video` request. Evidence is written beneath
`~/.local/share/video-services/descriptor-smoke/`.

Install and activate the exact runtime pinned in
`runtime/llama-cpp.lock.json`:

```bash
npm run runtime:install -w descriptor
```

For development, build and activate an uncommitted local llama.cpp checkout:

```bash
npm run runtime:install -w descriptor -- \
  --source /path/to/llama.cpp \
  --jobs 6
```

Runtime builds default to one job per available logical CPU. Use `--jobs` to
override that explicit limit. The installer also normalizes ccache paths to the
selected source root so clean checkouts can reuse compiled objects.

Run a smoke test against a remuxed media file:

```bash
npm run smoke -w descriptor -- "/path/to/video.mp4"
```

For long or production-sized inputs, run the bounded form:

```bash
npm run smoke:bounded -w descriptor -- "/path/to/video.mp4"
```

It runs the descriptor in a transient user scope with aggregate CPU capped at
80% of logical host capacity, memory pressure starting at 70%, a hard 80%
physical-memory limit, and no swap. Exceeding the memory ceiling terminates the
descriptor scope rather than exhausting host RAM and swap.

The descriptor launches the runtime itself unless `DESCRIPTOR_MODEL_URL` points
to an already-running server. Relevant tuning variables are:

- `DESCRIPTOR_MAX_FPS` (default `4`; duration tiers and the token budget may lower it)
- `DESCRIPTOR_VIDEO_TOKEN_BUDGET` (default `115000`)
- `DESCRIPTOR_TOKENS_PER_FRAME` (default `70.5`)
- `DESCRIPTOR_LLAMA_SERVER`, `DESCRIPTOR_MODEL_PATH`, and `DESCRIPTOR_MMPROJ_PATH`

The direct Gemma 4 template is intentional. The GGUF embeds a thinking/tool
template that can leave the reasoning channel open during schema-constrained
requests. Descriptor output needs neither reasoning nor tools, so the minimal
template preserves the required turn and media tokens while allowing llama.cpp
to enforce JSON from the first generated token.

The duration policy uses up to 4 FPS below seven minutes, up to 2 FPS from seven
to below fifteen minutes, and up to 1 FPS thereafter. The token budget remains
authoritative inside every tier, so full 4 FPS fits through approximately 6:48,
full 2 FPS through 13:36, and full 1 FPS through 27:11.

Longer videos keep roughly 1,631 sampled frames: 0.453 FPS at one hour and
0.2266 FPS (one frame every 4.41 seconds) at two hours. Transfer scheduling
controls resource duty while FPS controls evidence quality and context fit.
