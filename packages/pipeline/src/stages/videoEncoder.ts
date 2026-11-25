// The video encoder of a conversion. Production is x264 on the CPU; the NVENC encoder on an
// NVIDIA GPU exists for comparisons (convert-sample) and takes a constant-quality level.
// Only the encoder differs: the decode, the filters and the container stay the same.
export type VideoEncoder =
    | { readonly kind: "x264" }
    | { readonly kind: "nvenc"; readonly cq: number };

export const PRODUCTION_VIDEO_ENCODER: VideoEncoder = { kind: "x264" };

export function videoEncoderArgs(encoder: VideoEncoder): string[] {
    if (encoder.kind === "x264") return ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p"];
    if (!Number.isFinite(encoder.cq) || encoder.cq < 1 || encoder.cq > 51) {
        throw new Error(`NVENC constant quality must be 1 to 51, not ${encoder.cq}`);
    }
    // NVENC's slowest, best preset with every quality tool it has: two passes at full
    // resolution, spatial and temporal adaptive quantization, look-ahead and B-frames used
    // as references. Constant quality, like x264's CRF: without a high ceiling of its own,
    // NVENC's VBR caps the bitrate near 16 Mbit/s and every level under about 18 encodes
    // the same.
    return ["-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-profile:v", "high",
        "-rc", "vbr", "-cq", String(encoder.cq), "-b:v", "0", "-maxrate", "250M", "-bufsize", "500M",
        "-multipass", "fullres", "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "8",
        "-rc-lookahead", "32", "-bf", "3", "-b_ref_mode", "middle", "-pix_fmt", "yuv420p"];
}

// A short name for file names: x264-slow-crf16, nvenc-p7-cq18.
export function videoEncoderLabel(encoder: VideoEncoder): string {
    return encoder.kind === "x264" ? "x264-slow-crf16" : `nvenc-p7-cq${encoder.cq}`;
}
