/**
 * Browser-side video (de)muxing with FFmpeg.wasm.
 *
 * We use the single-threaded @ffmpeg/core, which does NOT require
 * cross-origin isolation (COOP/COEP) headers, so the app deploys anywhere.
 * The core (~32MB wasm) is fetched from a CDN on first use and cached.
 *
 * Responsibilities:
 *  - probe a video (fps, resolution, frame count, whether it has audio)
 *  - explode it into PNG frames at the original resolution/fps
 *  - re-assemble processed (transparent) PNG frames into a VP9-alpha WebM at
 *    the exact original fps, muxing the original audio track back in
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

export type VideoInfo = {
  /** Frames per second as an exact rational, e.g. "30000/1001". */
  fpsRational: string;
  /** fps as a number, for display and frame-count math. */
  fps: number;
  width: number;
  height: number;
  /** Duration in seconds. */
  duration: number;
  hasAudio: boolean;
};

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

export type FFmpegLoadOptions = {
  onProgress?: (ratio: number) => void;
  onLog?: (line: string) => void;
};

// Cache the core blob URLs so reloads don't re-download the ~32MB wasm.
let coreURL: string | null = null;
let wasmURL: string | null = null;

async function ensureCoreURLs(): Promise<{ coreURL: string; wasmURL: string }> {
  if (!coreURL) {
    coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript");
  }
  if (!wasmURL) {
    wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm");
  }
  return { coreURL, wasmURL };
}

/** Load (once) the FFmpeg.wasm core. */
export async function getFFmpeg(
  options: FFmpegLoadOptions = {},
): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const instance = new FFmpeg();
    if (options.onLog) {
      instance.on("log", ({ message }) => options.onLog?.(message));
    }
    await instance.load(await ensureCoreURLs());
    ffmpeg = instance;
    return instance;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

/**
 * Terminate the current FFmpeg worker (freeing its entire WASM heap) and load a
 * FRESH instance. This is the ONLY reliable way to reclaim FFmpeg.wasm memory
 * between operations — the single-thread core grows its heap on every exec()
 * and never shrinks it, so a long video eventually hits the 2GB cap and throws
 * "memory access out of bounds". The virtual filesystem does NOT survive this,
 * so callers must persist any needed files to JS (Blobs) before reloading.
 */
export async function reloadFFmpeg(): Promise<FFmpeg> {
  try {
    ffmpeg?.terminate();
  } catch {
    // ignore
  }
  ffmpeg = null;
  loadPromise = null;
  return getFFmpeg();
}

/**
 * Fully unload FFmpeg: terminate the worker and drop the cached core blob URLs
 * so the next use re-downloads a fresh core. Used by "Clear data".
 */
export async function unloadFFmpeg(): Promise<void> {
  try {
    ffmpeg?.terminate();
  } catch {
    // ignore
  }
  ffmpeg = null;
  loadPromise = null;
  if (coreURL) URL.revokeObjectURL(coreURL);
  if (wasmURL) URL.revokeObjectURL(wasmURL);
  coreURL = null;
  wasmURL = null;
}

/** True if the FFmpeg core is currently loaded in memory. */
export function isFFmpegLoaded(): boolean {
  return !!ffmpeg?.loaded;
}

const IN = "input";
const FRAME_DIR = "frames";
const OUT_DIR = "out";
const AUDIO = "audio.m4a";

/**
 * Probe the video by parsing ffmpeg's stderr log (there is no ffprobe in the
 * wasm build). Runs a no-op decode to a null muxer and reads the stream info.
 */
export async function probeVideo(file: File | Blob): Promise<VideoInfo> {
  const ff = await getFFmpeg();
  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => lines.push(message);
  ff.on("log", onLog);

  await ff.writeFile(IN, await fetchFile(file));
  // `-f null -` decodes without writing output; stream info is logged to stderr.
  await ff.exec(["-i", IN, "-f", "null", "-"]).catch(() => {
    // ffmpeg returns non-zero on the null muxer path; the log still has info.
  });
  ff.off("log", onLog);

  const text = lines.join("\n");

  // Video stream line, e.g.:
  // "Stream #0:0 ...: Video: h264 ..., 1280x720 ..., 30 fps, 30 tbr, ..."
  const videoLine = lines.find((l) => /Stream #.*Video:/.test(l)) ?? "";
  const sizeMatch = videoLine.match(/(\d{2,5})x(\d{2,5})/);
  const width = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  const height = sizeMatch ? parseInt(sizeMatch[2], 10) : 0;

  // Prefer tbr / fps token for the frame rate.
  const fpsMatch =
    videoLine.match(/([\d.]+)\s*fps/) ?? videoLine.match(/([\d.]+)\s*tbr/);
  const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

  // Duration line: "Duration: 00:00:12.34, ..."
  const durMatch = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = durMatch
    ? parseInt(durMatch[1], 10) * 3600 +
      parseInt(durMatch[2], 10) * 60 +
      parseFloat(durMatch[3])
    : 0;

  const hasAudio = /Stream #.*Audio:/.test(text);

  await ff.deleteFile(IN).catch(() => {});

  return {
    fpsRational: rationalizeFps(fps),
    fps,
    width,
    height,
    duration,
    hasAudio,
  };
}

/**
 * Extract just the first frame as a PNG Blob — used for the live preview so we
 * don't decode the whole video. Returns the frame at its native resolution.
 */
export async function extractFirstFrame(file: File | Blob): Promise<Blob> {
  const ff = await getFFmpeg();
  await ff.writeFile(IN, await fetchFile(file));
  await ff.exec(["-i", IN, "-frames:v", "1", "first.png"]);
  const data = await ff.readFile("first.png");
  await ff.deleteFile("first.png").catch(() => {});
  await ff.deleteFile(IN).catch(() => {});
  return new Blob([toBytes(data)], { type: "image/png" });
}

/**
 * Extract a single frame at a given timestamp (seconds) as a PNG Blob — used by
 * the frame slider so the user can preview any frame, not just the first.
 */
export async function extractFrameAt(
  file: File | Blob,
  atSec: number,
): Promise<Blob> {
  const ff = await getFFmpeg();
  await ff.writeFile(IN, await fetchFile(file));
  // -ss before -i seeks fast; -frames:v 1 grabs a single frame there.
  await ff.exec([
    "-ss",
    Math.max(0, atSec).toFixed(6),
    "-i",
    IN,
    "-frames:v",
    "1",
    "at.png",
  ]);
  const data = await ff.readFile("at.png");
  await ff.deleteFile("at.png").catch(() => {});
  await ff.deleteFile(IN).catch(() => {});
  return new Blob([toBytes(data)], { type: "image/png" });
}

/** Copy FileData into a Blob-safe buffer (plain ArrayBuffer backing). */
function toBytes(data: unknown): Uint8Array<ArrayBuffer> {
  const u8 = data as Uint8Array;
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return new Uint8Array(buf);
}

/** Read a file from the virtual FS as a Blob. */
export async function readFile(
  ff: FFmpeg,
  path: string,
  type = "image/png",
): Promise<Blob> {
  const data = await ff.readFile(path);
  return new Blob([toBytes(data)], { type });
}

// --- Batched, memory-bounded pipeline ------------------------------------
//
// FFmpeg.wasm (single-thread core) is hard-capped at 2GB of WASM memory. If we
// exploded a whole video into PNGs and kept every processed PNG too, a modest
// clip would exceed that and crash with "memory access out of bounds".
//
// So we process the video in time-windowed BATCHES. For each batch we:
//   1. extract only that batch's frames (bounded input memory),
//   2. hand them to the caller to remove backgrounds (frames deleted as used),
//   3. encode the batch's processed frames into a segment WebM,
//   4. delete the batch's frames, keeping only the small segment file.
// Finally we losslessly concat the segments and mux the audio back in.

export type FrameRef = { path: string; index: number };

/** Write the input video into MEMFS once; reused across all batches. */
export async function mountInput(file: File | Blob): Promise<void> {
  const ff = await getFFmpeg();
  await ff.writeFile(IN, await fetchFile(file));
}

/** Remove the mounted input video from MEMFS. */
export async function unmountInput(): Promise<void> {
  const ff = await getFFmpeg();
  await ff.deleteFile(IN).catch(() => {});
}

/**
 * Extract the audio track once (if any) as AAC/m4a and return it as a JS Blob
 * so it survives FFmpeg reloads. m4a is used as the common source that the
 * final WebM (→ Opus) and MP4 (→ AAC) mux steps each re-encode from. Assumes
 * the input is already mounted.
 */
export async function extractAudioBlob(info: VideoInfo): Promise<Blob | null> {
  if (!info.hasAudio) return null;
  const ff = await getFFmpeg();
  let ok = true;
  await ff
    .exec(["-i", IN, "-vn", "-c:a", "aac", AUDIO])
    .catch(() => (ok = false));
  if (!ok || !(await fileExists(ff, AUDIO))) return null;
  const blob = await readFile(ff, AUDIO, "audio/mp4");
  return blob;
}

/**
 * Extract the frames whose timestamps fall in [startSec, startSec+durSec) into
 * FRAME_DIR, numbered by their GLOBAL frame index so ordering is preserved
 * across batches. Assumes the input is already mounted via `mountInput`.
 */
export async function extractBatchFrames(
  info: VideoInfo,
  startSec: number,
  durSec: number,
  globalStartIndex: number,
): Promise<FrameRef[]> {
  const ff = await getFFmpeg();
  await ensureCleanDir(ff, FRAME_DIR);

  // Seek to the window and decode exactly its frames. -vsync 0 avoids dup/drop
  // so we get exactly the source frames.
  const ret = await ff.exec([
    "-ss",
    startSec.toFixed(6),
    "-t",
    durSec.toFixed(6),
    "-i",
    IN,
    "-vsync",
    "0",
    `${FRAME_DIR}/f_%06d.png`,
  ]);
  if (ret !== 0) {
    throw new Error(`Frame extraction failed (ffmpeg exit ${ret})`);
  }

  const entries = await ff.listDir(FRAME_DIR);
  const local = entries
    // Defensive: a crashed core can return malformed FS entries.
    .filter(
      (e) =>
        e &&
        !e.isDir &&
        typeof e.name === "string" &&
        e.name.startsWith("f_") &&
        e.name.endsWith(".png"),
    )
    .map((e) => e.name)
    .sort();

  return local.map((name, i) => ({
    path: `${FRAME_DIR}/${name}`,
    index: globalStartIndex + i,
  }));
}

/** Read one extracted frame as a Blob, then delete it to free memory. */
export async function takeFrame(ff: FFmpeg, path: string): Promise<Blob> {
  const blob = await readFile(ff, path, "image/png");
  await ff.deleteFile(path).catch(() => {});
  return blob;
}

/**
 * Encode the alpha PNGs currently in OUT_DIR (out_%06d.png, from 1) into a
 * transparent VP9-alpha WebM segment. Reads them IN PLACE — no JS round-trip —
 * so it's a single exec on the current heap. Clears OUT_DIR afterwards.
 */
export async function encodeWebMSegmentInPlace(
  info: VideoInfo,
  segmentIndex: number,
): Promise<Blob> {
  const ff = await getFFmpeg();
  const seg = `seg_${String(segmentIndex).padStart(4, "0")}.webm`;

  // Codec choice — measured on the ACTUAL @ffmpeg/core WASM binary
  // (24 frames @ 1080p, driven directly in Node):
  //   VP9 default effort:      550MB heap, 33.3s  — works but ~1.4s/frame
  //   VP9 -cpu-used ≥ 5:       CRASHES ("memory access out of bounds" at only
  //                            ~265MB — a bug in this build's VP9 fast path,
  //                            NOT heap exhaustion. Do not use VP9 speed flags.)
  //   VP8 realtime -cpu-used 8: 199MB heap, 2.7s  — 12× faster, no crash.
  // VP8 is WebM's original alpha format (alpha_mode=1) and plays in the same
  // browsers, so the transparent WebM is encoded with VP8.
  const bitrateK = Math.max(
    1500,
    Math.min(20000, Math.round((info.width * info.height * info.fps * 0.12) / 1000)),
  );
  const ret = await ff.exec([
    "-framerate",
    info.fpsRational,
    "-i",
    `${OUT_DIR}/out_%06d.png`,
    "-c:v",
    "libvpx",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-crf",
    "10",
    "-b:v",
    `${bitrateK}k`,
    "-r",
    info.fpsRational,
    seg,
  ]);
  if (ret !== 0) {
    throw new Error(`WebM encode failed (ffmpeg exit ${ret})`);
  }

  const blob = await readFile(ff, seg, "video/webm");
  await ff.deleteFile(seg).catch(() => {});
  await ensureCleanDir(ff, OUT_DIR);
  return blob;
}

/**
 * Encode the alpha PNGs currently in OUT_DIR into an OPAQUE H.264 MP4 segment,
 * flattening the transparent areas over a solid color. Encoded straight from the
 * PNGs (which carry correct alpha) — NOT from a WebM, whose alpha ffmpeg can't
 * reliably re-decode. Single exec on the current heap; clears OUT_DIR afterwards.
 */
export async function encodeMp4SegmentInPlace(
  info: VideoInfo,
  segmentIndex: number,
  mp4Color: string,
): Promise<Blob> {
  const ff = await getFFmpeg();
  const seg = `seg_${String(segmentIndex).padStart(4, "0")}.mp4`;
  const color = ffColor(mp4Color);

  const ret = await ff.exec([
    "-framerate",
    info.fpsRational,
    "-i",
    `${OUT_DIR}/out_%06d.png`,
    "-filter_complex",
    `color=c=${color}:s=${info.width}x${info.height}:r=${info.fpsRational}[bg];` +
      `[bg][0:v]overlay=shortest=1,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    // ultrafast: x264's default `medium` preset is slow in single-thread WASM;
    // ultrafast is many× faster for a modest size increase.
    "-preset",
    "ultrafast",
    "-crf",
    "22",
    "-r",
    info.fpsRational,
    seg,
  ]);
  if (ret !== 0) {
    throw new Error(`MP4 encode failed (ffmpeg exit ${ret})`);
  }

  const blob = await readFile(ff, seg, "video/mp4");
  await ff.deleteFile(seg).catch(() => {});
  await ensureCleanDir(ff, OUT_DIR);
  return blob;
}

/** Normalize a "#rrggbb" color to ffmpeg's "0xRRGGBB" form. */
function ffColor(hex: string): string {
  const h = hex.replace(/^#/, "");
  return `0x${h.length === 3 ? h.split("").map((c) => c + c).join("") : h}`;
}

/**
 * Concatenate a list of same-format segment Blobs losslessly (-c copy) and mux
 * the audio Blob back in if present. Runs on a FRESH FFmpeg with an empty FS.
 *
 * @param ext        "webm" or "mp4"
 * @param audioCodec ffmpeg audio encoder for the muxed track ("libopus"/"aac")
 */
async function concatFormat(
  segmentBlobs: Blob[],
  ext: "webm" | "mp4",
  audioBlob: Blob | null,
  audioCodec: string,
): Promise<Blob> {
  const ff = await getFFmpeg();

  const names: string[] = [];
  for (let i = 0; i < segmentBlobs.length; i++) {
    const name = `s_${String(i).padStart(4, "0")}.${ext}`;
    await ff.writeFile(name, new Uint8Array(await segmentBlobs[i].arrayBuffer()));
    names.push(name);
  }

  await ff.writeFile("concat.txt", names.map((s) => `file '${s}'`).join("\n"));

  const concatOut = `concat.${ext}`;
  await ff.exec([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    "concat.txt",
    "-c",
    "copy",
    concatOut,
  ]);

  let finalName = concatOut;
  if (audioBlob) {
    const audioIn = `audio_in.${ext === "webm" ? "webm" : "m4a"}`;
    await ff.writeFile(audioIn, new Uint8Array(await audioBlob.arrayBuffer()));
    finalName = `output.${ext}`;
    await ff.exec([
      "-i",
      concatOut,
      "-i",
      audioIn,
      "-c:v",
      "copy",
      "-c:a",
      audioCodec,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-shortest",
      finalName,
    ]);
    await ff.deleteFile(audioIn).catch(() => {});
  }

  const mime = ext === "webm" ? "video/webm" : "video/mp4";
  const blob = await readFile(ff, finalName, mime);

  // Clean up so a subsequent format concat starts clean.
  for (const n of names) await ff.deleteFile(n).catch(() => {});
  await ff.deleteFile("concat.txt").catch(() => {});
  await ff.deleteFile(concatOut).catch(() => {});
  if (finalName !== concatOut) await ff.deleteFile(finalName).catch(() => {});

  return blob;
}

/** Concatenate the transparent WebM segments (+ Opus audio). */
export function concatWebM(
  segmentBlobs: Blob[],
  audioBlob: Blob | null,
): Promise<Blob> {
  return concatFormat(segmentBlobs, "webm", audioBlob, "libopus");
}

/** Concatenate the opaque MP4 segments (+ AAC audio). */
export function concatMP4(
  segmentBlobs: Blob[],
  audioBlob: Blob | null,
): Promise<Blob> {
  return concatFormat(segmentBlobs, "mp4", audioBlob, "aac");
}

// --- FS helpers ----------------------------------------------------------

export async function ensureCleanDir(ff: FFmpeg, dir: string): Promise<void> {
  try {
    const entries = await ff.listDir(dir);
    for (const e of entries) {
      if (!e.isDir) await ff.deleteFile(`${dir}/${e.name}`).catch(() => {});
    }
  } catch {
    await ff.createDir(dir).catch(() => {});
  }
}

export async function prepareOutputDir(ff: FFmpeg): Promise<string> {
  await ensureCleanDir(ff, OUT_DIR);
  return OUT_DIR;
}

async function fileExists(ff: FFmpeg, path: string): Promise<boolean> {
  try {
    await ff.readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Cleanup all working files/dirs for a fresh run. */
export async function resetWorkspace(ff: FFmpeg): Promise<void> {
  await ensureCleanDir(ff, FRAME_DIR).catch(() => {});
  await ensureCleanDir(ff, OUT_DIR).catch(() => {});
  await ff.deleteFile(IN).catch(() => {});
  await ff.deleteFile(AUDIO).catch(() => {});
  await ff.deleteFile("concat.txt").catch(() => {});
  await ff.deleteFile("concat.webm").catch(() => {});
  await ff.deleteFile("output.webm").catch(() => {});
  // Sweep any stray segment files from a previous aborted run.
  try {
    const root = await ff.listDir("/");
    for (const e of root) {
      if (!e.isDir && /^seg_\d+\.webm$/.test(e.name)) {
        await ff.deleteFile(e.name).catch(() => {});
      }
    }
  } catch {
    // ignore
  }
}

export const FRAME_DIR_NAME = FRAME_DIR;
export const OUT_DIR_NAME = OUT_DIR;

// --- misc ----------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Turn common decimal fps into an exact rational to avoid drift. */
function rationalizeFps(fps: number): string {
  const known: Record<string, string> = {
    "23.976": "24000/1001",
    "23.98": "24000/1001",
    "29.97": "30000/1001",
    "59.94": "60000/1001",
    "119.88": "120000/1001",
  };
  const key = fps.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
  const key3 = fps.toFixed(3);
  return known[key] ?? known[key3] ?? String(fps);
}
