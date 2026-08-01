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

import { removeBackground, type LoadProgress } from "./background-remover";
import {
  getFFmpeg,
  reloadFFmpeg,
  probeVideo,
  extractFirstFrame,
  mountInput,
  unmountInput,
  extractAudioBlob,
  extractBatchFrames,
  takeFrame,
  encodeSegmentBlob,
  concatSegmentBlobs,
  prepareOutputDir,
  resetWorkspace,
  diag,
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

export type VideoResult = {
  blob: Blob;
  url: string;
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

/**
 * Render a preview of the first frame with the background removed and the
 * chosen background applied. Returns an object URL (caller revokes it).
 */
export async function previewFirstFrame(
  file: File | Blob,
  background: Background,
  onModelProgress?: (p: LoadProgress) => void,
): Promise<{ url: string; width: number; height: number }> {
  const ff = await getFFmpeg();
  await resetWorkspace(ff);

  const info = await probeVideo(file);
  // Only decode the first frame — no need to explode the whole video to preview.
  const firstPng = await extractFirstFrame(file);
  const cut = await removeBackground(firstPng, { onProgress: onModelProgress });
  const composed = await compositeBackground(cut.blob, background);

  // Free the cut-out object URL from removeBackground; we only need `composed`.
  URL.revokeObjectURL(cut.url);

  return {
    url: URL.createObjectURL(composed),
    width: info.width,
    height: info.height,
  };
}

// How many frames to hold in FFmpeg memory per batch. Kept small so that
// peak WASM memory stays well under the single-thread core's 2GB cap,
// regardless of the video's length or resolution.
const BATCH_FRAMES = 24;

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
  background: Background,
  {
    onProgress,
    onModelProgress,
  }: {
    onProgress?: (p: VideoProgress) => void;
    onModelProgress?: (p: LoadProgress) => void;
  } = {},
): Promise<VideoResult> {
  const report = (p: VideoProgress) => onProgress?.(p);
  const transparent = background.kind === "transparent";

  // 1. Ensure FFmpeg is ready and the workspace is clean.
  report({ stage: "loading-ffmpeg", ratio: 0 });
  let ff = await getFFmpeg();
  await resetWorkspace(ff);

  // 2. Probe (self-contained: writes + deletes its own input).
  report({ stage: "probing", ratio: 0 });
  const info = await probeVideo(file);
  if (!info.width || !info.height) {
    throw new Error("Could not read the video's dimensions.");
  }

  const estFrames = Math.max(1, Math.round(info.duration * info.fps));

  // 3. Extract the audio ONCE, persisted to a JS Blob (survives FFmpeg reloads).
  diag(`extracting audio (hasAudio=${info.hasAudio})`);
  let audioBlob: Blob | null = null;
  if (info.hasAudio) {
    await mountInput(file);
    audioBlob = await step("extractAudio", () => extractAudioBlob(info));
    await unmountInput();
    await reloadFFmpeg(); // fresh heap before the batch loop
    ff = await getFFmpeg();
  }

  // 4. Process in time-windowed batches. CRUCIAL: FFmpeg.wasm grows its WASM
  // heap on every exec() and never frees it, so after a handful of batches it
  // hits the 2GB cap ("memory access out of bounds"). We therefore TERMINATE
  // and RELOAD FFmpeg after each batch — the only reliable way to reclaim its
  // memory — persisting each finished segment to a JS Blob first.
  const batchDur = BATCH_FRAMES / info.fps;
  const batchCount = Math.max(1, Math.ceil(info.duration / batchDur));
  const segmentBlobs: Blob[] = [];
  let processed = 0;

  report({ stage: "removing", ratio: 0, frameIndex: 0, frameCount: estFrames });

  for (let b = 0; b < batchCount; b++) {
    const startSec = b * batchDur;

    // Each batch runs on a fresh FFmpeg heap. Mount the input (it lives in JS
    // as `file`, so this is cheap and the heap starts near-empty each time).
    await mountInput(file);

    report({
      stage: "extracting",
      ratio: b / batchCount,
      frameIndex: processed,
      frameCount: estFrames,
    });
    diag(`batch ${b}/${batchCount} extract (ss=${startSec.toFixed(2)})`);
    const frames = await step("extractBatchFrames", () =>
      extractBatchFrames(info, startSec, batchDur, processed),
    );
    diag(`batch ${b} extracted ${frames.length} frames`);
    if (frames.length === 0) {
      await reloadFFmpeg();
      ff = await getFFmpeg();
      continue;
    }

    // Input no longer needed for this batch — free it before writing outputs.
    await unmountInput();
    await prepareOutputDir(ff);

    // Remove background from each frame, one at a time (bounded memory).
    for (let i = 0; i < frames.length; i++) {
      const inputPng = await step("takeFrame", () =>
        takeFrame(ff, frames[i].path),
      );
      const cut = await step("removeBackground", () =>
        removeBackground(inputPng, { onProgress: onModelProgress }),
      );
      if (processed === 0) diag(`model backend = ${cut.backend}`);
      const composed = await step("composite", () =>
        compositeBackground(cut.blob, background),
      );
      URL.revokeObjectURL(cut.url);

      const name = `${OUT_DIR_NAME}/out_${String(i + 1).padStart(6, "0")}.png`;
      await step("writeFrame", async () =>
        ff.writeFile(name, new Uint8Array(await composed.arrayBuffer())),
      );

      processed += 1;
      if (processed % 10 === 0) diag(`processed ${processed}/${estFrames}`);
      report({
        stage: "removing",
        ratio: Math.min(1, processed / estFrames),
        frameIndex: processed,
        frameCount: estFrames,
      });
    }

    // Encode this batch into a segment Blob (persisted to JS)...
    report({
      stage: "encoding",
      ratio: (b + 1) / batchCount,
      frameIndex: processed,
      frameCount: estFrames,
    });
    const seg = await step("encodeSegment", () =>
      encodeSegmentBlob(info, b, transparent),
    );
    segmentBlobs.push(seg);

    // ...then RELOAD FFmpeg to hand back all its WASM heap for the next batch.
    diag(`batch ${b} done, reloading ffmpeg to free memory`);
    await reloadFFmpeg();
    ff = await getFFmpeg();
  }

  if (segmentBlobs.length === 0) {
    throw new Error("No frames could be extracted from the video.");
  }

  // 5. Concatenate the segment Blobs (lossless) and mux audio, on a fresh heap.
  diag(`concat ${segmentBlobs.length} segments (audio=${!!audioBlob})`);
  report({
    stage: "encoding",
    ratio: 1,
    frameIndex: processed,
    frameCount: processed,
  });
  const blob = await step("concatSegments", () =>
    concatSegmentBlobs(segmentBlobs, audioBlob),
  );

  const url = URL.createObjectURL(blob);
  report({ stage: "done", ratio: 1 });

  return { blob, url, info, frameCount: processed };
}

/** Wrap a pipeline step so a failure reports WHICH step failed and at what memory. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    diag(`FAILED at step "${name}"`);
    // eslint-disable-next-line no-console
    console.error(`[bgvideo] step "${name}" threw:`, err);
    throw new Error(
      `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
