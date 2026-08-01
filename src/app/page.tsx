"use client";

import { useState } from "react";
import { clearAllData } from "@/lib/video-background-remover";
import ImagePanel from "./ImagePanel";
import VideoPanel from "./VideoPanel";
import Link from "next/link";

type Tab = "image" | "video";

export default function Home() {
  const [tab, setTab] = useState<Tab>("image");
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

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
    <div className="relative flex flex-1 flex-col items-center bg-white px-5 py-12 font-sans text-neutral-900 sm:py-20 dark:bg-neutral-800 dark:text-neutral-50">
      <main className="relative z-10 flex w-full max-w-2xl flex-1 flex-col gap-9">
        <header className="flex flex-col gap-4">
          <div className="flex w-full flex-col items-center gap-2">
            <h1 className="text-center text-lg font-medium tracking-tight">
              Background Remover
            </h1>
            <p className="max-w-lg text-center text-[0.95rem] leading-7 text-neutral-500 dark:text-neutral-400">
              Remove backgrounds from images and video, entirely in your
              browser. Nothing is uploaded.
            </p>
          </div>

          <div className="mt-12 flex items-center justify-center gap-3">
            <Tabs tab={tab} onChange={setTab} />
          </div>
        </header>

        {tab === "image" ? <ImagePanel /> : <VideoPanel />}

        <footer className="mt-auto flex flex-col items-center gap-4 pt-10 text-center text-xs text-neutral-400 dark:text-neutral-500">
          <button
            type="button"
            onClick={onClear}
            disabled={clearing}
            className="text-xs font-medium text-red-500 underline-offset-4 transition-colors hover:text-red-600 hover:underline disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
            title="Delete the cached AI model and video engine from your browser"
          >
            {clearing
              ? "Clearing…"
              : cleared
                ? "Cleared ✓"
                : "Clear local data"}
          </button>
          <span>
            Runs 100% locally with{" "}
            <a
              href="https://github.com/huggingface/transformers.js"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              Transformers.js
            </a>
            ,{" "}
            <a
              href="https://huggingface.co/briaai/RMBG-1.4"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              RMBG-1.4
            </a>{" "}
            and{" "}
            <a
              href="https://github.com/ffmpegwasm/ffmpeg.wasm"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              FFmpeg.wasm
            </a>
            .
          </span>
        </footer>
      </main>

      <Link href={"https://halodesign.io"} target="_blank" className="text-xs opacity-60 fixed top-2 right-2 hover:underline underline-offset-2">
          A halodesign.io project
      </Link>

    </div>
  );
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Media type"
      className="inline-flex rounded-full bg-neutral-100 p-1 dark:bg-neutral-700/60"
    >
      {(["image", "video"] as const).map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          onClick={() => onChange(t)}
          className={[
            "h-10 w-28 rounded-full text-sm font-medium capitalize transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-50",
            tab === t
              ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-neutral-50"
              : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
          ].join(" ")}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
