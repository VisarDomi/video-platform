# Local model experiments

This is the durable log for descriptor model, context, VRAM, and throughput experiments. Update it after each meaningful run. Do not rely on terminal history.

## Test system

- Date: 2026-08-11
- GPU: NVIDIA GeForce RTX 3060, 12,288 MiB
- Idle GPU use outside the test server: approximately 880 MiB
- llama.cpp fork: commit `7ace165e3368b58ef3b8cd713065fba166c988d2`
  (`video-platform-fps`; per-request FPS commit `c868491e9`, based on upstream
  `0b1bad14f`)
- Model: `gemma-4-E4B-OBLITERATED-Q8_0.gguf` (7.5 GiB on disk)
- Multimodal projector: `mmproj-gemma-4-E4B-OBLITERATED-F16.gguf` (945 MiB on disk)
- Published model context: 131,072 tokens (128 Ki tokens)
- GPU layers: all (`-ngl 99`)
- Parallel slots: one (`-np 1`)
- Flash attention: enabled
- Image budget: `--image-max-tokens 70`
- KV offload: enabled (llama.cpp default)
- KV cache: stated per benchmark; exploratory runs used Q8_0, final near-128K benchmark used F16

The GGUF weight quant and KV-cache quant are independent. llama.cpp defaults both KV caches to F16 unless `--cache-type-k` and `--cache-type-v` are supplied. Exploratory results below used Q8_0 for both unless noted; the final near-128K benchmark explicitly used F16 for both.

## Purpose

Find a configuration that can process a real video occupying nearly the full 131,072-token context without CUDA OOM, including the vision encoder's transient allocations. Merely starting the server with `-c 131072` is not considered proof.

## Native-video behavior

The pinned llama.cpp fork uses FFmpeg to decode MP4 video and accepts a positive,
finite per-video sampling rate as `input_video.fps` on the OpenAI-compatible chat
request. Omitting the field preserves llama.cpp's 4 FPS default. The descriptor
chooses the request rate from video duration, its video-token budget, the
measured tokens per frame, and a configured maximum. Each frame uses
approximately 68 prompt tokens at `--image-max-tokens 70`.

## Measurements

Peak VRAM is the llama-server process reading reported by `nvidia-smi`, sampled every 100 ms. Wall time includes video loading, vision processing, prompt evaluation, and one generated token.

| Video | Duration | Sampling | Prompt tokens | Wall time | Prompt rate | Peak server VRAM | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| `boo_1234` | 12.35 s | 0.5 FPS | 464 | 3.08 s | 199.2 tok/s | 8,488 MiB | success: fractional FPS |
| `boo_1234` | 12.35 s | 4 FPS | 3,396 | 11.0 s | — | — | success (earlier native-video proof) |
| `boo_1234` | 12.35 s | 8 FPS | 6,720 | 27.8 s | 253.0 tok/s | 8,304 MiB | success |
| `boo_1234` | 12.35 s | 16 FPS | 13,452 | 55.9 s | 250.0 tok/s | 8,406 MiB | success |
| `boo_1234` | 12.35 s | native 29.97 FPS | 25,148 | 106.7 s | 243.6 tok/s | 8,430 MiB | success |
| `cath777` | 176.27 s | 1 FPS | 12,272 | 58.5 s | 232.0 tok/s | 8,336 MiB | success |
| `cath777` | 176.27 s | 4 FPS | 47,972 | 219.5 s | 227.2 tok/s | 8,398 MiB | success |
| `lyliiii` | 1,840.03 s | 1 FPS | 129,014 | 628.2 s | 224.2 tok/s | 8,820 MiB | success: Q8_0 weights + F16 KV |
| `boo_1234` | 12.35 s | request 0.5 FPS | 553 | 10.08 s | 269.6 tok/s | — | success on pinned fork |
| `boo_1234` | 12.35 s | request 1 FPS | 961 | 32.27 s | 206.0 tok/s | — | success: quality comparison |
| `cath777` | 176.27 s | request 0.5 FPS | 6,445 | 43.89 s | 215.4 tok/s | — | success: quality comparison |
| `cath777` | 176.27 s | request 1 FPS | 12,361 | 59.81 s | 260.2 tok/s | — | success on pinned fork |

## Current observations

- Q8 model/projector plus the configured context initializes at approximately 7.9 GiB of process VRAM with Q8_0 KV; llama.cpp reserves KV storage at context creation rather than growing it token by token.
- Prompt tokens and runtime scale almost linearly with sampled frame count.
- Fractional sampling works: `fps_target = 0.5f` is passed through to FFmpeg and samples approximately one frame every two seconds.
- Per-request sampling is verified on the pinned fork at both fractional 0.5 FPS and 1 FPS. The complete upstream `test-chat` suite also passes, including omitted, fractional, zero, negative, and nonnumeric `input_video.fps` cases.
- Q8_0 weights with native F16 KV successfully processed a 129,014-token real video prompt, proving the near-full 128K configuration on this GPU.
- Reducing frame rate loses temporal evidence. It is a pipeline/quality decision, not a memory optimization equivalent to cache quantization.
- No lower weight or KV quantization is required for the 12 GB GPU. Q8_0 weights + F16 KV is the selected configuration.
- The fixed 0.5/1/4 FPS comparison established the cost/quality tradeoff. Spare
  pipeline capacity is now spent on 4/2/1 FPS duration tiers, with the token
  budget lowering rates near tier boundaries and on long recordings.

At the configured 115,000-token video budget and measured 70.5 tokens per
frame, full 4 FPS fits through 6:48, full 2 FPS through 13:36, and full 1 FPS
through 27:11. A one-hour video uses about 0.453 FPS and a two-hour video about
0.2266 FPS (one frame every 4.41 seconds), keeping roughly 1,631 sampled frames
at each longer duration. Production chooses FPS from duration and the token
budget; transfer pacing is a separate scheduler responsibility.

## Why VRAM stays nearly flat during prompt evaluation

llama.cpp allocates the KV buffers when it creates the 131,072-token context. Processing additional tokens fills already-reserved buffers, so `nvidia-smi` should not grow linearly with evaluated-token progress. The identical server measured approximately 7,888 MiB after initialization with Q8_0 KV and 8,384 MiB with F16 KV, before processing a request. Starting video processing added approximately 432 MiB of vision/compute workspace that CUDA retained.

Gemma 4 E4B also has a cache-efficient architecture. Metadata read from this exact GGUF and the matching llama.cpp implementation show:

- 42 decoder layers
- a repeating five-sliding-window/one-global-attention pattern
- a 512-token sliding window
- 18 shared-KV layers, leaving only the first 24 layers with their own K/V projections
- only four full-context/global cache-owning layers among those first 24 layers
- optional/shared value projection behavior in the llama.cpp Gemma 4 graph

Consequently, most layers do not retain 128K positions and many later layers reuse KV state. This is why the full F16 KV reservation is much smaller than a naive `42 layers x 128K tokens` estimate.

## Candidate decision order

1. Test Q8 weights + F16 KV at nearly 128K real video tokens, because this is the highest-quality combination that might fit.
2. If it OOMs, retry the identical video and prompt with Q8_0 KV.
3. If Q8 weights + Q8 KV also OOMs, try Q6_K or Q5_K_M model weights while retaining Q8 KV.
4. After a full-context configuration fits, compare description quality across useful FPS values separately.

Step 4 completed on 2026-08-11; see the sampling decision below.

## Quantization decision

Selected: Q8_0 model weights with F16 keys and F16 values.

The fixed benchmark completed with HTTP 200, no truncation, and no CUDA OOM at 129,014 prompt tokens plus one generated token. Peak llama-server VRAM was 8,820 MiB, leaving ample device headroom even with approximately 900 MiB used by other desktop processes. The 131,072-token context retained 2,058 tokens for generation. Production prompts and requested output must fit within that remainder when a video reaches this benchmark size.

There is no reason to lower the model quant or KV precision for memory. F32 KV would consume more memory for negligible benefit with Q8_0 weights. BF16 KV offers wider range but less fractional precision than F16 and is not required merely because upstream weights may be published in BF16.

## Sampling quality decision

Selected: 4/2/1 FPS duration tiers with token-budget adaptation below them.

The fixed comparison used the same Q8_0/F16 model configuration, schema, and
prompt on two persistent remuxes:

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

The default `DESCRIPTOR_MAX_FPS` is therefore 4. Duration policy caps it at 4
FPS below seven minutes, 2 FPS from seven to below fifteen minutes, and 1 FPS
thereafter. The existing formula further reduces sampling when a tier would
exceed the 115,000-token budget. The six-month capacity calculation shows this
policy consumes about 25.2% descriptor duty, so the denser short-video evidence
does not threaten the upload schedule.

## Near-two-hour host-memory benchmark

The longest current eligible recording was remuxed without transcoding and run
through the bounded single-artifact command after changing local `file://` video handling
to stream from its validated path. The earlier implementation copied the whole
4.91 GB MP4 into two anonymous buffers and fed FFmpeg through `cache:pipe:0`.

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

At the comparable ingest point, anonymous memory fell from approximately
17.2 GB to 9.0 GB. The fixed run retained file-backed cache that Linux could
reclaim and completed with approximately 14.2 GB anonymous memory near the end
of context evaluation. Evidence:
`pipeline/descriptions/experiments/2026-08-11T23-05-25-619Z-715f2faf/result.json`.

## Fixed near-128K benchmark

- Source: `~/Videos/downloads/tango/editor/edited/2026-02-04 120231 lyliiii/playlist.m3u8`
- Remux: `/tmp/tango-remux/2026-02-04_120231_lyliiii.mp4`
- Remux operation: stream copy; source media is not transcoded
- MP4 duration: 1,840.025667 seconds
- MP4 size: 778,657,307 bytes (743 MiB)
- Video: H.264, 720x1280, 50 FPS source; sampled at 1 FPS for the benchmark
- Audio: AAC
- Expected prompt size: approximately 128,100 tokens based on the measured 1 FPS `cath777` run

Keep this MP4, sampling rate, prompt, `--image-max-tokens`, context size, and generated-token count fixed while comparing weight/KV quantization.

The first Q8-weights/F16-KV attempt was cancelled at 60,382 processed tokens because Node's built-in `fetch` client timed out waiting five minutes for response headers. It was not a CUDA/model failure; the server was healthy at 8,816 MiB. Long benchmark requests must use an HTTP client with its response timeout disabled. The corrected run completed in 628.2 seconds.

## Relevant upstream material

- Gemma 4 E4B model card: <https://huggingface.co/google/gemma-4-E4B>
- Gemma video guide: <https://ai.google.dev/gemma/docs/capabilities/vision/video>
- llama.cpp native-video support: <https://github.com/ggml-org/llama.cpp/pull/24269>
