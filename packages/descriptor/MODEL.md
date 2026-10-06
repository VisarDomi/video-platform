# Descriptor model configuration and measurements

The descriptor model, context, KV cache, and sampling settings below are the
ones `src/llama-server.ts`, `src/config.ts`, and `src/media.ts` use. The
measurements are the evidence for them; add new measurements here when a
setting is reconsidered.

## Configuration

- GPU: NVIDIA GeForce RTX 3060, 12,288 MiB (about 880 MiB used by other desktop processes)
- llama.cpp fork: `VisarDomi/llama.cpp` branch `video-platform-fps`, commit
  `7ace165e3368b58ef3b8cd713065fba166c988d2` (pinned in
  `runtime/llama-cpp.lock.json`; adds the per-request `input_video.fps`)
- Model: `gemma-4-E4B-OBLITERATED-Q8_0.gguf` (7.5 GiB on disk)
- Multimodal projector: `mmproj-gemma-4-E4B-OBLITERATED-F16.gguf` (945 MiB on disk)
- Context: 131,072 tokens (`-c 131072`)
- GPU layers: all (`-ngl 99`); parallel slots: one (`-np 1`)
- Flash attention: on
- KV cache: F16 keys and values (`--cache-type-k f16 --cache-type-v f16`)
- Image budget: `--image-max-tokens 70`
- Chat template: `gemma4-direct.jinja`, reasoning off
- Sampling: up to 4 FPS below seven minutes, 2 FPS below fifteen minutes,
  1 FPS thereafter, lowered further to fit the 115,000-token video budget at
  70.5 tokens per frame

The GGUF weight quant and the KV-cache quant are independent; llama.cpp
defaults both KV caches to F16 unless `--cache-type-k`/`--cache-type-v` say
otherwise. A configuration counts as fitting only when a real video occupying
nearly the full context runs without CUDA OOM, including the vision encoder's
transient allocations; starting the server with `-c 131072` is not proof.

## Native-video behavior

The pinned fork decodes MP4 video with FFmpeg and accepts a positive, finite
per-video sampling rate as `input_video.fps` on the OpenAI-compatible chat
request; omitting the field keeps llama.cpp's 4 FPS default. The descriptor
chooses the rate from video duration, its video-token budget, the measured
tokens per frame, and the configured maximum. Each frame uses approximately 68
prompt tokens at `--image-max-tokens 70`. Fractional rates work: 0.5 FPS samples
about one frame every two seconds.

## Measurements

Measured on 2026-08-11 on the GPU above. Peak VRAM is the llama-server process
reading reported by `nvidia-smi`, sampled every 100 ms. Wall time includes video
loading, vision processing, prompt evaluation, and one generated token. Runs
marked "request" set `input_video.fps` per request on the pinned fork.

| Video | Duration | Sampling | Prompt tokens | Wall time | Prompt rate | Peak server VRAM | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| `boo_1234` | 12.35 s | 0.5 FPS | 464 | 3.08 s | 199.2 tok/s | 8,488 MiB | success: fractional FPS |
| `boo_1234` | 12.35 s | 4 FPS | 3,396 | 11.0 s | — | — | success |
| `boo_1234` | 12.35 s | 8 FPS | 6,720 | 27.8 s | 253.0 tok/s | 8,304 MiB | success |
| `boo_1234` | 12.35 s | 16 FPS | 13,452 | 55.9 s | 250.0 tok/s | 8,406 MiB | success |
| `boo_1234` | 12.35 s | native 29.97 FPS | 25,148 | 106.7 s | 243.6 tok/s | 8,430 MiB | success |
| `cath777` | 176.27 s | 1 FPS | 12,272 | 58.5 s | 232.0 tok/s | 8,336 MiB | success |
| `cath777` | 176.27 s | 4 FPS | 47,972 | 219.5 s | 227.2 tok/s | 8,398 MiB | success |
| `lyliiii` | 1,840.03 s | 1 FPS | 129,014 | 628.2 s | 224.2 tok/s | 8,820 MiB | success: Q8_0 weights + F16 KV |
| `boo_1234` | 12.35 s | request 0.5 FPS | 553 | 10.08 s | 269.6 tok/s | — | success |
| `boo_1234` | 12.35 s | request 1 FPS | 961 | 32.27 s | 206.0 tok/s | — | success: quality comparison |
| `cath777` | 176.27 s | request 0.5 FPS | 6,445 | 43.89 s | 215.4 tok/s | — | success: quality comparison |
| `cath777` | 176.27 s | request 1 FPS | 12,361 | 59.81 s | 260.2 tok/s | — | success |

Observations:

- Prompt tokens and runtime scale almost linearly with sampled frame count.
- Per-request sampling works at both fractional 0.5 FPS and 1 FPS; the fork's
  upstream `test-chat` suite passes, including omitted, fractional, zero,
  negative, and nonnumeric `input_video.fps` cases.
- Reducing the frame rate loses temporal evidence. It is a quality decision, not
  a memory optimization equivalent to cache quantization.

Evidence files below are under `~/.local/share/video-services/`.

## Why VRAM stays nearly flat during prompt evaluation

llama.cpp allocates the KV buffers when it creates the 131,072-token context.
Processing additional tokens fills already-reserved buffers, so `nvidia-smi`
does not grow with evaluated-token progress. The same server measured about
7,888 MiB after initialization with Q8_0 KV and 8,384 MiB with F16 KV, before
any request. Starting video processing added about 432 MiB of vision/compute
workspace that CUDA retained.

Gemma 4 E4B also has a cache-efficient architecture. Metadata read from this
GGUF and the matching llama.cpp implementation show:

- 42 decoder layers
- a repeating five-sliding-window/one-global-attention pattern
- a 512-token sliding window
- 18 shared-KV layers, leaving only the first 24 layers with their own K/V projections
- only four full-context/global cache-owning layers among those first 24 layers
- optional/shared value projection behavior in the llama.cpp Gemma 4 graph

Consequently, most layers do not retain 128K positions and many later layers
reuse KV state, so the full F16 KV reservation is much smaller than a naive
`42 layers x 128K tokens` estimate.

## Quantization decision

Selected: Q8_0 model weights with F16 keys and F16 values.

The near-128K benchmark completed with HTTP 200, no truncation, and no CUDA OOM
at 129,014 prompt tokens plus one generated token. Peak llama-server VRAM was
8,820 MiB, leaving ample headroom next to about 900 MiB used by other desktop
processes. The 131,072-token context leaves 2,058 tokens for generation when a
video reaches this size; production prompts and the requested output must fit
in that remainder.

There is no reason to lower the model quant or KV precision for memory. F32 KV
would consume more memory for negligible benefit with Q8_0 weights. BF16 KV
offers wider range but less fractional precision than F16 and is not required
merely because upstream weights may be published in BF16.

## Sampling quality decision

Selected: 4/2/1 FPS duration tiers with token-budget adaptation below them
(`DESCRIPTOR_MAX_FPS` default 4).

The comparison used the same Q8_0/F16 configuration, schema, and prompt on two
persistent remuxes:

- `boo_1234`, 12.35 seconds: 553 prompt tokens at 0.5 FPS, 961 at 1 FPS, and
  3,477 at 4 FPS. All three identified the woman, black two-piece clothing,
  bed, room, and posing. The 4 FPS result added a leg-position detail but did
  not materially change the description; 1 FPS used 72% fewer prompt tokens.
- `cath777`, 176.27 seconds: 6,445 prompt tokens at 0.5 FPS, 12,361 at 1 FPS,
  and 48,061 at 4 FPS. The 0.5 FPS result retained the subject, blue backdrop,
  multiple light outfits, and posing, but 1 FPS described the range of fitted
  tops and short dresses more specifically. The 4 FPS result was less specific
  about that clothing range despite using nearly four times the 1 FPS tokens.

Evidence:

- 12.35 s / 0.5 FPS: `pipeline/descriptions/experiments/2026-08-11T20-25-00-230Z-3393e2f7/result.json`
- 12.35 s / 1 FPS: `pipeline/descriptions/experiments/2026-08-11T21-08-06-659Z-f236edc9/result.json`
- 12.35 s / 4 FPS: `pipeline/descriptions/experiments/2026-08-11T17-25-47-704Z-6c9d403c/result.json`
- 176.27 s / 0.5 FPS: `pipeline/descriptions/experiments/2026-08-11T21-09-07-200Z-58eedf08/result.json`
- 176.27 s / 1 FPS: `pipeline/descriptions/experiments/2026-08-11T20-26-16-152Z-e375e3dd/result.json`
- 176.27 s / 4 FPS: `pipeline/descriptions/experiments/2026-08-11T17-29-21-117Z-317865a2/result.json`

The tiers spend the most frames on short videos, where each frame matters most.
At the 115,000-token budget and 70.5 tokens per frame, full 4 FPS fits through
6:48, full 2 FPS through 13:36, and full 1 FPS through 27:11. A one-hour video
uses about 0.453 FPS and a two-hour video about 0.2266 FPS (one frame every 4.41
seconds), keeping roughly 1,631 sampled frames at each longer duration.
Transfer pacing is a separate scheduler responsibility.

## Near-two-hour host-memory benchmark

A near-two-hour recording was remuxed without transcoding and
run through the bounded single-artifact command. The descriptor stages local
media as a symlink in the runtime's `--media-path` directory, so the runtime
streams the file from disk rather than holding it in memory.

- Input: `descriptor-review/upper-limit/2026-07-04_110411_akaneppi.mp4`
- Duration: 6,970.005 seconds (1:56:10)
- Size: 4,907,805,084 bytes
- Adaptive sampling: 0.234032 FPS
- Prompt: 126,188 tokens; completion: 149 tokens; no truncation
- Prompt evaluation: 508.03 seconds at 248.39 tokens/second
- Total wall time: 758.02 seconds
- Bounded scope peak: 22,512,373,760 bytes (20.96 GiB)
- Descriptor-scope swap: zero throughout
- `MemoryHigh`, `MemoryMax`, and OOM events: zero

Anonymous memory was about 9.0 GB at ingest and about 14.2 GB near the end of
context evaluation; the rest of the peak was file-backed cache that Linux can
reclaim. Evidence:
`pipeline/descriptions/experiments/2026-08-11T23-05-25-619Z-715f2faf/result.json`.

## Near-128K benchmark

- Source: `~/Videos/downloads/tango/edited/2026-02-04 120231 lyliiii/playlist.m3u8`
- Remux: stream copy to MP4; source media is not transcoded
- MP4 duration: 1,840.025667 seconds
- MP4 size: 778,657,307 bytes (743 MiB)
- Video: H.264, 720x1280, 50 FPS source; sampled at 1 FPS
- Audio: AAC

Keep this input, sampling rate, prompt, `--image-max-tokens`, context size, and
generated-token count fixed when comparing weight/KV quantization. Requests this
long take more than five minutes before response headers arrive, so the HTTP
client must not time out waiting for them (Node's built-in `fetch` does; the
descriptor's `postJson` uses `node:http` without a response timeout).

## Relevant upstream material

- Gemma 4 E4B model card: <https://huggingface.co/google/gemma-4-E4B>
- Gemma video guide: <https://ai.google.dev/gemma/docs/capabilities/vision/video>
- llama.cpp native-video support: <https://github.com/ggml-org/llama.cpp/pull/24269>
