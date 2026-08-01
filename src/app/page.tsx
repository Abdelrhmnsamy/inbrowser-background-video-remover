"use client";

import { useEffect, useState } from "react";
import { isWebGPUAvailable } from "@/lib/background-remover";
import ImagePanel from "./ImagePanel";
import VideoPanel from "./VideoPanel";

type Tab = "image" | "video";

export default function Home() {
  const [tab, setTab] = useState<Tab>("image");
  const [webgpu, setWebgpu] = useState<boolean | null>(null);

  useEffect(() => {
    isWebGPUAvailable().then(setWebgpu);
  }, []);

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
            Remove the background from images and videos right in your browser.
            Nothing is uploaded — no server, no account. The AI model downloads
            once and is cached for next time.
          </p>
        </header>

        <Tabs tab={tab} onChange={setTab} />

        {tab === "image" ? <ImagePanel /> : <VideoPanel />}

        <footer className="mt-auto pt-8 text-sm text-zinc-500">
          Open source · Runs 100% locally with{" "}
          <a
            href="https://github.com/huggingface/transformers.js"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Transformers.js
          </a>
          ,{" "}
          <a
            href="https://huggingface.co/briaai/RMBG-1.4"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            RMBG-1.4
          </a>{" "}
          and{" "}
          <a
            href="https://github.com/ffmpegwasm/ffmpeg.wasm"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            FFmpeg.wasm
          </a>
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
      className="inline-flex w-fit gap-1 rounded-full border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900"
    >
      {(["image", "video"] as const).map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          onClick={() => onChange(t)}
          className={[
            "h-9 rounded-full px-5 text-sm font-medium capitalize transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500",
            tab === t
              ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
              : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
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
