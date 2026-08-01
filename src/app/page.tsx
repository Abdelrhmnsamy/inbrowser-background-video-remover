"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  removeBackground,
  isWebGPUAvailable,
  type Backend,
  type LoadProgress,
} from "@/lib/background-remover";

type Status = "idle" | "loading-model" | "processing" | "done" | "error";

type Job = {
  originalUrl: string;
  originalName: string;
  resultUrl: string | null;
  backend: Backend | null;
  ms: number | null;
};

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  // Track the URLs we create so we can revoke them and avoid memory leaks.
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    isWebGPUAvailable().then(setWebgpu);
  }, []);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const track = (url: string) => {
    urlsRef.current.push(url);
    return url;
  };

  const handleFile = useCallback(async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      setError("Please choose a PNG, JPEG, WebP, or GIF image.");
      setStatus("error");
      return;
    }

    setError(null);
    setProgress(null);
    const originalUrl = track(URL.createObjectURL(file));
    setJob({
      originalUrl,
      originalName: file.name,
      resultUrl: null,
      backend: null,
      ms: null,
    });
    setStatus("loading-model");

    const startedAt = performance.now();
    try {
      const result = await removeBackground(file, {
        onProgress: (p) => {
          setProgress(p);
          // Once the first weights start streaming we're clearly past "idle".
          setStatus((s) => (s === "loading-model" ? "loading-model" : s));
        },
      });
      // Model is loaded; the heavy inference is what "processing" reflects.
      setStatus("processing");
      const ms = Math.round(performance.now() - startedAt);
      setJob((prev) =>
        prev
          ? {
              ...prev,
              resultUrl: track(result.url),
              backend: result.backend,
              ms,
            }
          : prev,
      );
      setStatus("done");
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
      setStatus("error");
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const busy = status === "loading-model" || status === "processing";

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-4 py-10 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50 sm:py-16">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-8">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Background Remover
            </h1>
            <BackendBadge webgpu={webgpu} />
          </div>
          <p className="max-w-xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Removes the background from any image right in your browser. The
            image never leaves your device — no upload, no server, no account.
            The AI model downloads once and is cached for next time.
          </p>
        </header>

        {/* Dropzone */}
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          disabled={busy}
          aria-label="Choose an image or drop one here"
          className={[
            "group relative flex min-h-44 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition-colors duration-150",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500",
            dragOver
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
              : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
            busy
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-600",
          ].join(" ")}
        >
          <UploadIcon className="h-8 w-8 text-zinc-400" />
          <span className="text-base font-medium">
            Drop an image here, or{" "}
            <span className="text-blue-600 dark:text-blue-400">browse</span>
          </span>
          <span className="text-sm text-zinc-500">
            PNG, JPEG, WebP or GIF — processed locally
          </span>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED.join(",")}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
        </button>

        {/* Progress / status */}
        {busy && (
          <div
            className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {status === "loading-model"
                  ? "Downloading AI model (first run only)…"
                  : "Removing background…"}
              </span>
              {progress && status === "loading-model" && (
                <span className="tabular-nums text-zinc-500">
                  {progress.progress}%
                </span>
              )}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-full rounded-full bg-blue-500 transition-[width] duration-200 ease-out motion-reduce:transition-none"
                style={{
                  width:
                    status === "processing"
                      ? "100%"
                      : `${progress?.progress ?? 5}%`,
                }}
              />
            </div>
            {progress && status === "loading-model" && progress.file && (
              <span className="truncate text-xs text-zinc-400">
                {progress.file}
              </span>
            )}
          </div>
        )}

        {error && (
          <div
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Before / after */}
        {job && (
          <section className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Panel label="Original">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={job.originalUrl}
                  alt="Original"
                  className="max-h-80 w-full object-contain"
                />
              </Panel>
              <Panel label="Result" checkered>
                {job.resultUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={job.resultUrl}
                    alt="Background removed"
                    className="max-h-80 w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full min-h-52 items-center justify-center text-sm text-zinc-400">
                    {busy ? "Working…" : "—"}
                  </div>
                )}
              </Panel>
            </div>

            {status === "done" && job.resultUrl && (
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={job.resultUrl}
                  download={toPngName(job.originalName)}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition-colors duration-150 hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  <DownloadIcon className="h-4 w-4" />
                  Download PNG
                </a>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="inline-flex h-11 items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium transition-colors duration-150 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Try another image
                </button>
                {job.backend && job.ms != null && (
                  <span className="text-xs text-zinc-500">
                    {job.backend === "webgpu" ? "WebGPU" : "CPU (WASM)"} ·{" "}
                    {(job.ms / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            )}
          </section>
        )}

        <footer className="mt-auto pt-8 text-sm text-zinc-500">
          Open source · Runs 100% locally with{" "}
          <a
            href="https://github.com/huggingface/transformers.js"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Transformers.js
          </a>{" "}
          +{" "}
          <a
            href="https://huggingface.co/briaai/RMBG-1.4"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            RMBG-1.4
          </a>
        </footer>
      </main>
    </div>
  );
}

function Panel({
  label,
  children,
  checkered = false,
}: {
  label: string;
  children: React.ReactNode;
  checkered?: boolean;
}) {
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </figcaption>
      <div
        className={[
          "flex items-center justify-center overflow-hidden rounded-xl border border-zinc-200 p-3 dark:border-zinc-800",
          checkered ? "checkerboard" : "bg-white dark:bg-zinc-900",
        ].join(" ")}
      >
        {children}
      </div>
    </figure>
  );
}

function BackendBadge({ webgpu }: { webgpu: boolean | null }) {
  if (webgpu === null) return null;
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        webgpu
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
      ].join(" ")}
      title={
        webgpu
          ? "Your browser supports WebGPU — inference runs on the GPU."
          : "WebGPU unavailable — falling back to CPU (slower)."
      }
    >
      <span
        className={[
          "h-1.5 w-1.5 rounded-full",
          webgpu ? "bg-emerald-500" : "bg-amber-500",
        ].join(" ")}
      />
      {webgpu ? "WebGPU" : "CPU"}
    </span>
  );
}

function toPngName(name: string) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "image"}-no-bg.png`;
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4m0 0 4 4m-4-4L8 8" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v12m0 0 4-4m-4 4-4-4" />
      <path d="M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" />
    </svg>
  );
}
