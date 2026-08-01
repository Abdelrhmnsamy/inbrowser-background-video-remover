/**
 * End-to-end video background removal, all in the browser:
 *
 *   video --(ffmpeg)--> PNG frames --(RMBG-1.4)--> cut-out frames
 *         --composite chosen background--> PNG frames --(ffmpeg)--> WebM (+audio)
 *
 * Resolution and frame rate are preserved exactly (lossless PNG intermediate,
 * exact fps rational passed to the encoder). The background can be kept
 * transparent (VP9 alpha) or filled with a solid color.
 */

import {
  removeBackground,
  clearModelCache,
  type LoadProgress,
} from "./background-remover";
import {
  getFFmpeg,
  reloadFFmpeg,
  unloadFFmpeg,
  probeVideo,
  extractFirstFrame,
  extractFrameAt,
  mountInput,
  unmountInput,
  extractAudioBlob,
  extractBatchFrames,
  takeFrame,
  encodeWebMSegmentInPlace,
  encodeMp4SegmentInPlace,
  concatWebM,
  concatMP4,
  prepareOutputDir,
  resetWorkspace,
  OUT_DIR_NAME,
  type VideoInfo,
} from "./ffmpeg-video";

export type Background =
  | { kind: "transparent" }
  | { kind: "color"; color: string }; // e.g. "#000000"

export type VideoStage =
  | "loading-ffmpeg"
  | "probing"
  | "extracting"
  | "removing"
  | "encoding"
  | "done";

export type VideoProgress = {
  stage: VideoStage;
  /** 0–1 within the current stage. */
  ratio: number;
  /** For the "removing" stage: how many frames are done / total. */
  frameIndex?: number;
  frameCount?: number;
  /** For "loading-ffmpeg": model/core download detail, if available. */
  detail?: string;
};

export type VideoFormat = "webm" | "mp4";

export type VideoResult = {
  /** The single output in the chosen format. */
  blob: Blob;
  url: string;
  format: VideoFormat;
  info: VideoInfo;
  frameCount: number;
};

/**
 * Composite a cut-out PNG (RGBA with real alpha) over a background.
 * For "transparent" we return the cut-out unchanged. For a solid color we paint
 * the color first, then draw the cut-out on top — the removed area becomes that
 * color while anti-aliased edges blend correctly.
 */
export async function compositeBackground(
  cutout: Blob,
  background: Background,
): Promise<Blob> {
  if (background.kind === "transparent") return cutout;

  const bitmap = await createImageBitmap(cutout);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  ctx.fillStyle = background.color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob null"))),
      "image/png",
    );
  });
}

/** Probe the video for its dimensions, fps, duration, audio and frame count. */
export async function getVideoInfo(
  file: File | Blob,
): Promise<VideoInfo & { frameCount: number }> {
  const ff = await getFFmpeg();
  await resetWorkspace(ff);
  const info = await probeVideo(file);
  const frameCount = Math.max(1, Math.round(info.duration * info.fps));
  return { ...info, frameCount };
}

/**
 * Render a preview of a specific frame (1-based) with its background removed and
 * the chosen background applied. Returns an object URL (caller revokes it).
 */
export async function previewFrame(
  file: File | Blob,
  frameNumber: number,
  background: Background,
  info: VideoInfo,
  onModelProgress?: (p: LoadProgress) => void,
): Promise<{ url: string; width: number; height: number }> {
  await getFFmpeg();
  // Decode just the one requested frame (by timestamp).
  const png =
    frameNumber <= 1
      ? await extractFirstFrame(file)
      : await extractFrameAt(file, (frameNumber - 1) / info.fps);
  const cut = await removeBackground(png, { onProgress: onModelProgress });
  const composed = await compositeBackground(cut.blob, background);
  URL.revokeObjectURL(cut.url);

  return {
    url: URL.createObjectURL(composed),
    width: info.width,
    height: info.height,
  };
}

/**
 * Frames per batch, scaled to resolution so the per-batch working set (PNGs in
 * MEMFS + encoder buffers — measured ~200MB for VP8 and ~96MB for x264 at
 * 1080p on the real WASM core) stays far below the 2GB heap cap:
 * ~48 at ≤720p (fewer reloads → faster), ~24 at 1080p, ~8 at 4K (headroom).
 */
function batchFramesFor(info: VideoInfo): number {
  const px = Math.max(1, info.width * info.height);
  return Math.max(8, Math.min(48, Math.round(50_000_000 / px)));
}

/**
 * Full pipeline — processes the video in memory-bounded batches so it never
 * overflows FFmpeg.wasm's 2GB heap:
 *
 *   for each time window:
 *     extract that window's frames  → remove bg one at a time (delete as used)
 *     → write processed PNGs        → encode a segment WebM  → clear the batch
 *   concat all segment WebMs (lossless) → mux the original audio → done
 *
 * Frame rate and resolution are preserved exactly; segments concatenate without
 * re-encoding, so quality across batch seams is unaffected.
 */
export async function removeVideoBackground(
  file: File | Blob,
  /** Which single output to produce. */
  format: VideoFormat,
  /** The color used to fill the MP4 background (ignored for WebM). */
  mp4Color: string,
  options: {
    onProgress?: (p: VideoProgress) => void;
    onModelProgress?: (p: LoadProgress) => void;
  } = {},
): Promise<VideoResult> {
  try {
    return await removeVideoBackgroundImpl(file, format, mp4Color, options);
  } catch (err) {
    // Never leave a possibly-corrupted FFmpeg instance behind for the next run.
    await reloadFFmpeg().catch(() => {});
    throw err;
  }
}

async function removeVideoBackgroundImpl(
  file: File | Blob,
  format: VideoFormat,
  mp4Color: string,
  {
    onProgress,
    onModelProgress,
  }: {
    onProgress?: (p: VideoProgress) => void;
    onModelProgress?: (p: LoadProgress) => void;
  } = {},
): Promise<VideoResult> {
  const report = (p: VideoProgress) => onProgress?.(p);

  // 1. Start from a HARD-FRESH FFmpeg worker. The singleton can survive a
  // crashed previous run in a corrupted "loaded" state (aborted WASM core
  // returning garbage FS listings) — a reload guarantees a clean heap + FS.
  report({ stage: "loading-ffmpeg", ratio: 0 });
  let ff = await reloadFFmpeg();

  // 2. Probe (self-contained: writes + deletes its own input).
  report({ stage: "probing", ratio: 0 });
  const info = await probeVideo(file);
  if (!info.width || !info.height) {
    throw new Error("Could not read the video's dimensions.");
  }
  const estFrames = Math.max(1, Math.round(info.duration * info.fps));

  // 3. Extract the audio ONCE, persisted to a JS Blob (survives FFmpeg reloads).
  let audioBlob: Blob | null = null;
  if (info.hasAudio) {
    await mountInput(file);
    audioBlob = await extractAudioBlob(info);
    await unmountInput();
    await reloadFFmpeg(); // fresh heap before the batch loop
    ff = await getFFmpeg();
  }

  // 4. Process in time-windowed batches. FFmpeg.wasm grows its WASM heap on
  // every exec() and never frees it, so we TERMINATE and RELOAD FFmpeg after
  // each batch to reclaim memory, persisting each finished segment to a JS Blob
  // first. Exactly ONE encode per batch (the chosen format only) → one reload
  // per batch → same speed as the original WebM-only pipeline.
  const wantMp4 = format === "mp4";
  const batchDur = batchFramesFor(info) / info.fps;
  const batchCount = Math.max(1, Math.ceil(info.duration / batchDur));
  const segs: Blob[] = [];
  let processed = 0;

  report({ stage: "removing", ratio: 0, frameIndex: 0, frameCount: estFrames });

  for (let b = 0; b < batchCount; b++) {
    const startSec = b * batchDur;
    await mountInput(file); // fresh heap each batch → cheap re-mount

    report({
      stage: "extracting",
      ratio: b / batchCount,
      frameIndex: processed,
      frameCount: estFrames,
    });
    const frames = await extractBatchFrames(info, startSec, batchDur, processed);
    if (frames.length === 0) {
      await reloadFFmpeg();
      ff = await getFFmpeg();
      continue;
    }

    await unmountInput();
    await prepareOutputDir(ff);

    // Remove background from each frame, one at a time (bounded memory).
    for (let i = 0; i < frames.length; i++) {
      const inputPng = await takeFrame(ff, frames[i].path);
      const cut = await removeBackground(inputPng, {
        onProgress: onModelProgress,
      });
      const alphaPng = new Uint8Array(await cut.blob.arrayBuffer());
      URL.revokeObjectURL(cut.url);

      const name = `${OUT_DIR_NAME}/out_${String(i + 1).padStart(6, "0")}.png`;
      await ff.writeFile(name, alphaPng);

      processed += 1;
      report({
        stage: "removing",
        ratio: Math.min(1, processed / estFrames),
        frameIndex: processed,
        frameCount: estFrames,
      });
    }

    report({
      stage: "encoding",
      ratio: (b + 1) / batchCount,
      frameIndex: processed,
      frameCount: estFrames,
    });

    // Encode ONLY the chosen format for this batch (single exec), directly from
    // the alpha PNGs still in OUT_DIR — then reload once to free the heap.
    segs.push(
      wantMp4
        ? await encodeMp4SegmentInPlace(info, b, mp4Color)
        : await encodeWebMSegmentInPlace(info, b),
    );
    await reloadFFmpeg();
    ff = await getFFmpeg();
  }

  if (segs.length === 0) {
    throw new Error("No frames could be extracted from the video.");
  }

  // 5. Concatenate the segments (lossless) + mux audio, on a fresh heap.
  report({
    stage: "encoding",
    ratio: 1,
    frameIndex: processed,
    frameCount: processed,
  });
  const blob = wantMp4
    ? await concatMP4(segs, audioBlob)
    : await concatWebM(segs, audioBlob);

  report({ stage: "done", ratio: 1 });

  return {
    blob,
    url: URL.createObjectURL(blob),
    format,
    info,
    frameCount: processed,
  };
}

export type ClearResult = { modelCacheEntries: number };

/**
 * Clear all locally-stored data: the cached AI model weights, the FFmpeg core,
 * and any in-memory session. The next run re-downloads what it needs.
 */
export async function clearAllData(): Promise<ClearResult> {
  const modelCacheEntries = await clearModelCache();
  await unloadFFmpeg();
  return { modelCacheEntries };
}
