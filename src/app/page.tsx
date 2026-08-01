"use client";

import { useEffect, useState } from "react";
import { isWebGPUAvailable } from "@/lib/background-remover";
import { clearAllData } from "@/lib/video-background-remover";
import ImagePanel from "./ImagePanel";
import VideoPanel from "./VideoPanel";

type Tab = "image" | "video";

export default function Home() {
  const [tab, setTab] = useState<Tab>("image");
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    isWebGPUAvailable().then(setWebgpu);
  }, []);

  const onClear = async () => {
    if (clearing) return;
    setClearing(true);
    setCleared(false);
    try {
      await clearAllData();
      setCleared(true);
      setTimeout(() => setCleared(false), 2500);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center bg-white px-5 py-12 font-sans text-zinc-900 dark:bg-black dark:text-zinc-50 sm:py-20">
      <main className="flex w-full max-w-2xl flex-1 flex-col gap-9">
        <header className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
                Background Remover
              </h1>
              <p className="max-w-lg text-[0.95rem] leading-7 text-zinc-500 dark:text-zinc-400">
                Remove backgrounds from images and video, entirely in your
                browser. Nothing is uploaded.
              </p>
            </div>
            <BackendBadge webgpu={webgpu} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <Tabs tab={tab} onChange={setTab} />
            <button
              type="button"
              onClick={onClear}
              disabled={clearing}
              className="text-xs font-medium text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-700 hover:underline disabled:opacity-50 dark:hover:text-zinc-200"
              title="Delete the cached AI model and video engine from your browser"
            >
              {clearing
                ? "Clearing…"
                : cleared
                  ? "Cleared ✓"
                  : "Clear local data"}
            </button>
          </div>
        </header>

        {tab === "image" ? <ImagePanel /> : <VideoPanel />}

        <footer className="mt-auto flex flex-col gap-1 pt-10 text-xs text-zinc-400">
          <span>
            Runs 100% locally with{" "}
            <a
              href="https://github.com/huggingface/transformers.js"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              Transformers.js
            </a>
            ,{" "}
            <a
              href="https://huggingface.co/briaai/RMBG-1.4"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              RMBG-1.4
            </a>{" "}
            and{" "}
            <a
              href="https://github.com/ffmpegwasm/ffmpeg.wasm"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              FFmpeg.wasm
            </a>
            .
          </span>
        </footer>
      </main>
    </div>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Media type"
      className="inline-flex gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-900"
    >
      {(["image", "video"] as const).map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          onClick={() => onChange(t)}
          className={[
            "h-8 rounded-full px-4 text-sm font-medium capitalize transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-white",
            tab === t
              ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white"
              : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
          ].join(" ")}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function BackendBadge({ webgpu }: { webgpu: boolean | null }) {
  if (webgpu === null) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
      title={
        webgpu
          ? "WebGPU is available — inference runs on the GPU."
          : "WebGPU unavailable — running on CPU (slower)."
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
