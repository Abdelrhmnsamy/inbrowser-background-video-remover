"use client";

import { useCallback, useState, type RefObject } from "react";

export function Dropzone({
  accept,
  disabled,
  inputRef,
  onFile,
  title,
  subtitle,
}: {
  accept: string[];
  disabled?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void;
  title: string;
  subtitle: string;
}) {
  const [dragOver, setDragOver] = useState(false);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      disabled={disabled}
      aria-label={title}
      className={[
        "group relative flex min-h-44 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition-colors duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500",
        dragOver
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
          : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-600",
      ].join(" ")}
    >
      <UploadIcon className="h-8 w-8 text-zinc-400" />
      <span className="text-base font-medium">{title}</span>
      <span className="text-sm text-zinc-500">{subtitle}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(",")}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </button>
  );
}

export function Panel({
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

export function ProgressBar({
  label,
  percent,
  showPercent = false,
  detail,
  indeterminate = false,
}: {
  label: string;
  percent: number;
  showPercent?: boolean;
  detail?: string;
  indeterminate?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        {showPercent && (
          <span className="tabular-nums text-zinc-500">{pct}%</span>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        {indeterminate ? (
          <div className="indeterminate h-full w-1/3 rounded-full bg-blue-500" />
        ) : (
          <div
            className="h-full rounded-full bg-blue-500 transition-[width] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {detail && (
        <span className="truncate text-xs text-zinc-400">{detail}</span>
      )}
    </div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
      role="alert"
    >
      {children}
    </div>
  );
}

export function UploadIcon({ className }: { className?: string }) {
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
