"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  removeBackground,
  type Backend,
  type LoadProgress,
} from "@/lib/background-remover";
import { Dropzone, Panel, ProgressBar, ErrorBox } from "./ui";

type Status = "idle" | "loading-model" | "processing" | "done" | "error";

type Job = {
  originalUrl: string;
  originalName: string;
  resultUrl: string | null;
  backend: Backend | null;
  ms: number | null;
};

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export default function ImagePanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

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
        onProgress: (p) => setProgress(p),
      });
      setStatus("processing");
      const ms = Math.round(performance.now() - startedAt);
      setJob((prev) =>
        prev
          ? { ...prev, resultUrl: track(result.url), backend: result.backend, ms }
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

  const busy = status === "loading-model" || status === "processing";

  return (
    <div className="flex flex-col gap-6">
      <Dropzone
        accept={ACCEPTED}
        disabled={busy}
        inputRef={fileInput}
        onFile={handleFile}
        title="Drop an image here, or browse"
        subtitle="PNG, JPEG, WebP or GIF — processed locally"
      />

      {busy && (
        <ProgressBar
          label={
            status === "loading-model"
              ? "Downloading AI model (first run only)…"
              : "Removing background…"
          }
          percent={status === "processing" ? 100 : (progress?.progress ?? 5)}
          showPercent={status === "loading-model" && !!progress}
          detail={status === "loading-model" ? progress?.file : undefined}
        />
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

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
                <div className="flex h-full min-h-52 items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
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
                className="btn-primary"
              >
                Download PNG
              </a>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="btn-secondary"
              >
                Try another image
              </button>
              {job.backend && job.ms != null && (
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {job.backend === "webgpu" ? "WebGPU" : "CPU (WASM)"} ·{" "}
                  {(job.ms / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function toPngName(name: string) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "image"}-no-bg.png`;
}
