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

/** Read the JS heap size (Chrome only) in MB, for diagnostics. */
export function jsHeapMB(): number {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  return perf.memory ? Math.round(perf.memory.usedJSHeapSize / 1048576) : -1;
}

/** Emit a diagnostic line to the console with heap sizes. */
export function diag(label: string): void {
  // eslint-disable-next-line no-console
  console.log(`[bgvideo] ${label} — jsHeap=${jsHeapMB()}MB`);
}

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
 * Extract the audio track once (if any) and return it as a JS Blob so it
 * survives FFmpeg reloads. Assumes the input is already mounted.
 */
export async function extractAudioBlob(info: VideoInfo): Promise<Blob | null> {
  if (!info.hasAudio) return null;
  const ff = await getFFmpeg();
  let ok = true;
  await ff
    .exec(["-i", IN, "-vn", "-c:a", "libopus", AUDIO])
    .catch(() => (ok = false));
  if (!ok || !(await fileExists(ff, AUDIO))) return null;
  const blob = await readFile(ff, AUDIO, "audio/webm");
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

  // Seek to the window and decode exactly its frames. -copyts keeps timing sane;
  // -vsync 0 avoids dup/drop so we get exactly the source frames.
  await ff.exec([
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

  const entries = await ff.listDir(FRAME_DIR);
  const local = entries
    .filter((e) => !e.isDir && e.name.startsWith("f_") && e.name.endsWith(".png"))
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
 * Encode the processed PNGs currently in OUT_DIR (named out_%06d.png, contiguous
 * from 1) into a segment WebM and return it as a JS Blob (so it survives an
 * FFmpeg reload). Clears OUT_DIR afterwards.
 */
export async function encodeSegmentBlob(
  info: VideoInfo,
  segmentIndex: number,
  transparent: boolean,
): Promise<Blob> {
  const ff = await getFFmpeg();
  const seg = `seg_${String(segmentIndex).padStart(4, "0")}.webm`;
  const pixFmt = transparent ? "yuva420p" : "yuv420p";

  await ff.exec([
    "-framerate",
    info.fpsRational,
    "-i",
    `${OUT_DIR}/out_%06d.png`,
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    pixFmt,
    "-auto-alt-ref",
    "0",
    "-crf",
    "28",
    "-b:v",
    "0",
    "-r",
    info.fpsRational,
    seg,
  ]);

  const blob = await readFile(ff, seg, "video/webm");
  await ff.deleteFile(seg).catch(() => {});
  await ensureCleanDir(ff, OUT_DIR);
  return blob;
}

/**
 * Concatenate the segment WebM Blobs (lossless -c copy) and mux the audio Blob
 * back in if present. Runs on a FRESH FFmpeg with an empty FS: the segment and
 * audio Blobs are written in from JS. Returns the final WebM blob.
 */
export async function concatSegmentBlobs(
  segmentBlobs: Blob[],
  audioBlob: Blob | null,
): Promise<Blob> {
  const ff = await getFFmpeg();

  const names: string[] = [];
  for (let i = 0; i < segmentBlobs.length; i++) {
    const name = `seg_${String(i).padStart(4, "0")}.webm`;
    await ff.writeFile(name, new Uint8Array(await segmentBlobs[i].arrayBuffer()));
    names.push(name);
  }

  const list = names.map((s) => `file '${s}'`).join("\n");
  await ff.writeFile("concat.txt", list);

  const concatOut = "concat.webm";
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
    await ff.writeFile(AUDIO, new Uint8Array(await audioBlob.arrayBuffer()));
    finalName = "output.webm";
    await ff.exec([
      "-i",
      concatOut,
      "-i",
      AUDIO,
      "-c:v",
      "copy",
      "-c:a",
      "libopus",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-shortest",
      finalName,
    ]);
  }

  const blob = await readFile(ff, finalName, "video/webm");
  return blob;
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
