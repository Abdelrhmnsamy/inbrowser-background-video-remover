"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadProgress } from "@/lib/background-remover";
import {
  removeVideoBackground,
  previewFirstFrame,
  type Background,
  type VideoProgress,
  type VideoResult,
} from "@/lib/video-background-remover";
import { Dropzone, Panel, ProgressBar, ErrorBox } from "./ui";

const ACCEPTED = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];

// "Transparent" plus a few common solid colors. Default is black.
const SWATCHES: { label: string; value: Background }[] = [
  { label: "Transparent", value: { kind: "transparent" } },
  { label: "Black", value: { kind: "color", color: "#000000" } },
  { label: "White", value: { kind: "color", color: "#ffffff" } },
  { label: "Green screen", value: { kind: "color", color: "#00b140" } },
  { label: "Blue", value: { kind: "color", color: "#1d4ed8" } },
];

type Phase = "idle" | "previewing" | "ready" | "processing" | "done" | "error";

export default function VideoPanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [background, setBackground] = useState<Background>({
    kind: "color",
    color: "#000000",
  });
  const [customColor, setCustomColor] = useState("#000000");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [modelProgress, setModelProgress] = useState<LoadProgress | null>(null);
  const [vprogress, setVprogress] = useState<VideoProgress | null>(null);
  const [result, setResult] = useState<VideoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);
  // Bumped on every new preview request so stale async results are ignored.
  const previewSeq = useRef(0);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const track = (url: string) => {
    urlsRef.current.push(url);
    return url;
  };

  const runPreview = useCallback(async (f: File, bg: Background) => {
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    setError(null);
    try {
      const { url, width, height } = await previewFirstFrame(f, bg, (p) =>
        setModelProgress(p),
      );
      if (seq !== previewSeq.current) {
        URL.revokeObjectURL(url); // a newer preview superseded this one
        return;
      }
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return track(url);
      });
      setDims({ w: width, h: height });
      setPhase("ready");
    } catch (err) {
      if (seq !== previewSeq.current) return;
      console.error(err);
      setError(
        err instanceof Error
          ? err.message
          : "Could not read that video. Try MP4, MOV, WebM, or MKV.",
      );
      setPhase("error");
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  }, []);

  const handleFile = useCallback(
    (f: File) => {
      setFile(f);
      setResult(null);
      setVprogress(null);
      setPhase("previewing");
      runPreview(f, background);
    },
    [background, runPreview],
  );

  // Re-render the preview when the chosen background changes.
  const selectBackground = useCallback(
    (bg: Background) => {
      setBackground(bg);
      if (file && (phase === "ready" || phase === "previewing")) {
        setPhase("previewing");
        runPreview(file, bg);
      }
    },
    [file, phase, runPreview],
  );

  const start = useCallback(async () => {
    if (!file) return;
    setPhase("processing");
    setError(null);
    setResult(null);
    try {
      const res = await removeVideoBackground(file, background, {
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
  }, [file, background]);

  const processing = phase === "processing";

  return (
    <div className="flex flex-col gap-6">
      {phase === "idle" && (
        <Dropzone
          accept={ACCEPTED}
          inputRef={fileInput}
          onFile={handleFile}
          title="Drop a video here, or browse"
          subtitle="MP4, MOV, WebM or MKV — processed locally, frame by frame"
        />
      )}

      {/* Background picker + live first-frame preview */}
      {file && phase !== "processing" && phase !== "done" && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Background
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {SWATCHES.map((s) => (
                <SwatchButton
                  key={s.label}
                  swatch={s}
                  active={sameBg(s.value, background)}
                  onClick={() => selectBackground(s.value)}
                />
              ))}
              <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-zinc-300 px-3 text-sm dark:border-zinc-700">
                <span
                  className="h-4 w-4 rounded-full border border-black/10"
                  style={{ backgroundColor: customColor }}
                />
                Custom
                <input
                  type="color"
                  value={customColor}
                  onChange={(e) => {
                    setCustomColor(e.target.value);
                    selectBackground({ kind: "color", color: e.target.value });
                  }}
                  className="sr-only"
                  aria-label="Custom background color"
                />
              </label>
            </div>
          </div>

          <Panel
            label={`Preview — first frame${dims ? ` · ${dims.w}×${dims.h}` : ""}`}
            checkered={background.kind === "transparent"}
          >
            {previewLoading ? (
              <div className="flex h-full min-h-52 w-full items-center justify-center text-sm text-zinc-400">
                Rendering preview…
              </div>
            ) : previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="First-frame preview"
                className="max-h-80 w-full object-contain"
              />
            ) : (
              <div className="flex h-full min-h-52 items-center justify-center text-sm text-zinc-400">
                —
              </div>
            )}
          </Panel>

          {previewLoading && modelProgress && (
            <ProgressBar
              label="Downloading AI model (first run only)…"
              percent={modelProgress.progress}
              showPercent
              detail={modelProgress.file}
            />
          )}

          {phase === "ready" && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={start}
                className="inline-flex h-11 items-center justify-center rounded-full bg-zinc-900 px-6 text-sm font-medium text-white transition-colors duration-150 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Remove background from whole video
              </button>
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  setPreviewUrl(null);
                  setDims(null);
                  setPhase("idle");
                }}
                className="inline-flex h-11 items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors duration-150 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Choose a different video
              </button>
              <span className="text-xs text-zinc-500">
                Output: {background.kind === "transparent" ? "transparent WebM (VP9 alpha)" : "WebM"} · same resolution &amp; frame rate · audio kept
              </span>
            </div>
          )}
        </section>
      )}

      {/* Processing progress */}
      {processing && vprogress && (
        <ProcessingProgress p={vprogress} model={modelProgress} />
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      {/* Result */}
      {phase === "done" && result && (
        <section className="flex flex-col gap-4">
          <Panel
            label={`Result · ${result.info.width}×${result.info.height} · ${round(result.info.fps)} fps · ${result.frameCount} frames`}
            checkered={background.kind === "transparent"}
          >
            <video
              src={result.url}
              controls
              autoPlay
              loop
              muted
              playsInline
              className="max-h-96 w-full object-contain"
            />
          </Panel>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={result.url}
              download={downloadName(file?.name)}
              className="inline-flex h-11 items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition-colors duration-150 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Download WebM
            </a>
            <button
              type="button"
              onClick={() => {
                setFile(null);
                setResult(null);
                setPreviewUrl(null);
                setDims(null);
                setVprogress(null);
                setPhase("idle");
              }}
              className="inline-flex h-11 items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors duration-150 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Do another video
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Transparent WebM plays in Chrome, Edge and Firefox. To use it in an
            editor that wants ProRes/MOV, import the WebM or re-export there.
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
    removing: "Removing background from frames…",
    encoding: "Encoding transparent video…",
    done: "Done",
  };

  const isModelDownload =
    p.stage === "removing" && model && model.progress < 100;

  let percent = p.ratio * 100;
  let label = labels[p.stage];
  let detail: string | undefined;

  if (p.stage === "removing" && p.frameCount) {
    label = `Removing background — frame ${p.frameIndex ?? 0} / ${p.frameCount}`;
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

function SwatchButton({
  swatch,
  active,
  onClick,
}: {
  swatch: { label: string; value: Background };
  active: boolean;
  onClick: () => void;
}) {
  const isTransparent = swatch.value.kind === "transparent";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500",
        active
          ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
          : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800",
      ].join(" ")}
    >
      <span
        className={[
          "h-4 w-4 rounded-full border border-black/10",
          isTransparent ? "checkerboard" : "",
        ].join(" ")}
        style={
          isTransparent
            ? undefined
            : { backgroundColor: (swatch.value as { color: string }).color }
        }
      />
      {swatch.label}
    </button>
  );
}

function sameBg(a: Background, b: Background): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "color" && b.kind === "color") return a.color === b.color;
  return true;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function downloadName(name?: string): string {
  const base = (name ?? "video").replace(/\.[^.]+$/, "");
  return `${base || "video"}-no-bg.webm`;
}
