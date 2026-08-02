"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { LoadProgress } from "@/lib/background-remover";
import {
  removeVideoBackground,
  getVideoInfo,
  previewFrame,
  type VideoProgress,
  type VideoResult,
  type VideoFormat,
} from "@/lib/video-background-remover";
import type { VideoInfo } from "@/lib/ffmpeg-video";
import { Dropzone, Panel, ProgressBar, ErrorBox } from "./ui";

const ACCEPTED = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
];

// The color that fills the MP4 background. Default black.
const SWATCHES = ["#000000", "#ffffff", "#00b140", "#1d4ed8"];

type Phase = "idle" | "loading" | "ready" | "processing" | "done" | "error";

export default function VideoPanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<(VideoInfo & { frameCount: number }) | null>(
    null,
  );

  const [format, setFormat] = useState<VideoFormat>("webm");
  const [color, setColor] = useState("#000000");
  const [frame, setFrame] = useState(1); // 1-based slider position

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [modelProgress, setModelProgress] = useState<LoadProgress | null>(null);
  const [vprogress, setVprogress] = useState<VideoProgress | null>(null);
  const [result, setResult] = useState<VideoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);
  const previewSeq = useRef(0);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const track = (url: string) => {
    urlsRef.current.push(url);
    return url;
  };

  // The preview background: transparent for WebM, the chosen color for MP4.
  const renderPreview = useCallback(
    async (
      f: File,
      vinfo: VideoInfo,
      frameNum: number,
      fmt: VideoFormat,
      bgColor: string,
    ) => {
      const seq = ++previewSeq.current;
      setPreviewLoading(true);
      setError(null);
      try {
        const bg =
          fmt === "mp4"
            ? ({ kind: "color", color: bgColor } as const)
            : ({ kind: "transparent" } as const);
        const { url } = await previewFrame(f, frameNum, bg, vinfo, (p) =>
          setModelProgress(p),
        );
        if (seq !== previewSeq.current) {
          URL.revokeObjectURL(url);
          return;
        }
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return track(url);
        });
      } catch (err) {
        if (seq !== previewSeq.current) return;
        console.error(err);
        setError(
          err instanceof Error
            ? err.message
            : "Could not read that frame. Try another.",
        );
      } finally {
        if (seq === previewSeq.current) setPreviewLoading(false);
      }
    },
    [],
  );

  const handleFile = useCallback(
    async (f: File) => {
      setFile(f);
      setResult(null);
      setVprogress(null);
      setPreviewUrl(null);
      setPhase("loading");
      setError(null);
      try {
        const vinfo = await getVideoInfo(f);
        setInfo(vinfo);
        const mid = Math.max(1, Math.round(vinfo.frameCount / 2));
        setFrame(mid);
        setPhase("ready");
        await renderPreview(f, vinfo, mid, format, color);
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error
            ? err.message
            : "Could not read that video. Try MP4, MOV, WebM, or MKV.",
        );
        setPhase("error");
      }
    },
    [color, format, renderPreview],
  );

  // Re-render preview when the slider is released.
  const onFrameCommit = useCallback(() => {
    if (file && info) renderPreview(file, info, frame, format, color);
  }, [file, info, frame, format, color, renderPreview]);

  const selectColor = useCallback(
    (c: string) => {
      setColor(c);
      if (file && info) renderPreview(file, info, frame, "mp4", c);
    },
    [file, info, frame, renderPreview],
  );

  const selectFormat = useCallback(
    (fmt: VideoFormat) => {
      setFormat(fmt);
      if (file && info) renderPreview(file, info, frame, fmt, color);
    },
    [file, info, frame, color, renderPreview],
  );

  const start = useCallback(async () => {
    if (!file) return;
    setPhase("processing");
    setError(null);
    setResult(null);
    try {
      const res = await removeVideoBackground(file, format, color, {
        onProgress: setVprogress,
        onModelProgress: setModelProgress,
      });
      setResult({ ...res, url: track(res.url) });
      setPhase("done");
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "Processing failed. Try again.",
      );
      setPhase("error");
    }
  }, [file, format, color]);

  const reset = () => {
    setFile(null);
    setInfo(null);
    setPreviewUrl(null);
    setResult(null);
    setVprogress(null);
    setError(null);
    setPhase("idle");
  };

  return (
    <div className="flex flex-col gap-6">
      {phase === "idle" && (
        <Dropzone
          accept={ACCEPTED}
          inputRef={fileInput}
          onFile={handleFile}
          title="Drop a video, paste, or browse"
          subtitle="Drop, paste (⌘V), or browse — MP4, MOV, WebM, MKV"
        />
      )}

      {phase === "loading" && (
        <ProgressBar label="Reading video…" percent={30} indeterminate />
      )}

      {/* Setup: preview + frame scrubber + format + color */}
      {file && info && phase === "ready" && (
        <section className="flex flex-col gap-5">
          <Panel
            label={`Preview · frame ${frame} of ${info.frameCount} · ${info.width}×${info.height}`}
            checkered={format === "webm"}
          >
            {previewLoading ? (
              <div className="flex h-full min-h-56 w-full items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
                Rendering frame…
              </div>
            ) : previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={`Frame ${frame} preview`}
                className="max-h-96 w-full object-contain"
                style={
                  format === "mp4" ? { backgroundColor: color } : undefined
                }
              />
            ) : (
              <div className="flex h-full min-h-56 items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
                —
              </div>
            )}
          </Panel>

          {/* Frame scrubber */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              <span>Preview frame</span>
              <span className="tabular-nums text-neutral-400 dark:text-neutral-500">
                {frame} / {info.frameCount}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={info.frameCount}
              value={frame}
              onChange={(e) => setFrame(Number(e.target.value))}
              onMouseUp={onFrameCommit}
              onTouchEnd={onFrameCommit}
              onKeyUp={onFrameCommit}
              aria-label="Preview frame"
              className="scrubber w-full"
              style={
                {
                  "--fill": `${
                    ((frame - 1) / Math.max(1, info.frameCount - 1)) * 100
                  }%`,
                } as CSSProperties
              }
            />
          </div>

          {/* Output format */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Output format
            </span>
            <div className="inline-flex w-fit gap-1 rounded-full bg-neutral-100 p-1 dark:bg-neutral-700/60">
              {(
                [
                  ["webm", "WebM", "transparent"],
                  ["mp4", "MP4", "color background"],
                ] as const
              ).map(([f, label, hint]) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={format === f}
                  onClick={() => selectFormat(f)}
                  className={[
                    "flex h-8 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors duration-150",
                    format === f
                      ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-neutral-50"
                      : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
                  ].join(" ")}
                >
                  {label}
                  <span className="text-xs opacity-60">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Background color — only meaningful for MP4 */}
          {format === "mp4" && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                Background color
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => selectColor(c)}
                    aria-label={`Background ${c}`}
                    aria-pressed={color.toLowerCase() === c.toLowerCase()}
                    className={[
                      "h-8 w-8 rounded-full border transition-transform duration-150",
                      color.toLowerCase() === c.toLowerCase()
                        ? "border-neutral-900 ring-2 ring-neutral-900/20 dark:border-neutral-50 dark:ring-neutral-50/30"
                        : "border-black/10 hover:scale-105 dark:border-white/15",
                    ].join(" ")}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-full border border-neutral-300 px-3 text-sm text-neutral-700 dark:border-neutral-500 dark:text-neutral-300">
                  <span
                    className="h-4 w-4 rounded-full border border-black/10 dark:border-white/15"
                    style={{ backgroundColor: color }}
                  />
                  Custom
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => selectColor(e.target.value)}
                    className="sr-only"
                    aria-label="Custom background color"
                  />
                </label>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={start} className="btn-primary">
              Remove background · {format.toUpperCase()}
            </button>
            <button type="button" onClick={reset} className="btn-ghost">
              Choose another
            </button>
          </div>
        </section>
      )}

      {phase === "processing" && vprogress && (
        <ProcessingProgress p={vprogress} model={modelProgress} />
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      {phase === "done" && result && (
        <section className="flex flex-col gap-4">
          <Panel
            label={`Result · ${result.info.width}×${result.info.height} · ${round(result.info.fps)} fps · ${result.frameCount} frames`}
            checkered={result.format === "webm"}
          >
            <video
              src={result.url}
              controls
              autoPlay
              loop
              muted
              playsInline
              className="max-h-96 w-full object-contain"
              style={
                result.format === "mp4"
                  ? { backgroundColor: color }
                  : undefined
              }
            />
          </Panel>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={result.url}
              download={downloadName(file?.name, result.format)}
              className="btn-primary"
            >
              Download {result.format.toUpperCase()}
            </a>
            <button type="button" onClick={reset} className="btn-ghost">
              Do another
            </button>
          </div>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {result.format === "webm"
              ? "WebM keeps real transparency (Chrome, Edge, Firefox)."
              : "MP4 plays everywhere, including Safari and iPhone."}
          </p>
        </section>
      )}
    </div>
  );
}

function ProcessingProgress({
  p,
  model,
}: {
  p: VideoProgress;
  model: LoadProgress | null;
}) {
  const labels: Record<VideoProgress["stage"], string> = {
    "loading-ffmpeg": "Loading video engine…",
    probing: "Reading video…",
    extracting: "Extracting frames…",
    removing: "Removing background…",
    encoding: "Encoding video…",
    done: "Done",
  };

  const isModelDownload =
    p.stage === "removing" && model && model.progress < 100 && p.frameIndex === 0;

  let percent = p.ratio * 100;
  let label = labels[p.stage];
  let detail: string | undefined;

  if (p.stage === "removing" && p.frameCount) {
    label = `Removing background — frame ${p.frameIndex ?? 0} of ${p.frameCount}`;
  }
  if (isModelDownload) {
    label = "Downloading AI model (first run only)…";
    percent = model!.progress;
    detail = model!.file;
  }

  const indeterminate =
    (p.stage === "loading-ffmpeg" || p.stage === "probing") && p.ratio === 0;

  return (
    <ProgressBar
      label={label}
      percent={percent}
      showPercent={!indeterminate}
      detail={detail}
      indeterminate={indeterminate}
    />
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function downloadName(name: string | undefined, ext: string): string {
  const base = (name ?? "video").replace(/\.[^.]+$/, "");
  return `${base || "video"}-no-bg.${ext}`;
}
