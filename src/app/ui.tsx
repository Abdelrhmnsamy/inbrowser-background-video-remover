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
        "group relative flex min-h-52 w-full flex-col items-center justify-center gap-3 rounded-3xl border border-dashed p-10 text-center transition-[background-color,border-color] duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-50",
        dragOver
          ? "border-neutral-400 bg-neutral-100 dark:border-neutral-500 dark:bg-neutral-700"
          : "border-neutral-300 bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-700/50",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:border-neutral-400 hover:bg-neutral-100 dark:hover:border-neutral-500 dark:hover:bg-neutral-700",
      ].join(" ")}
    >
      <UploadIcon className="h-8 w-8 text-neutral-400 dark:text-neutral-400" />
      <span className="sr-only">{title}</span>
      <span className="text-sm text-neutral-500 dark:text-neutral-300">
        {subtitle}
      </span>
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
      <figcaption className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </figcaption>
      <div
        className={[
          "flex items-center justify-center overflow-hidden rounded-2xl border border-neutral-200 p-3 dark:border-neutral-600",
          checkered ? "checkerboard" : "bg-white dark:bg-neutral-700/40",
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
      className="flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-600 dark:bg-neutral-700/40"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between text-sm text-neutral-900 dark:text-neutral-50">
        <span className="font-medium">{label}</span>
        {showPercent && (
          <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
            {pct}%
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-600">
        {indeterminate ? (
          <div className="indeterminate h-full w-1/3 rounded-full bg-neutral-900 dark:bg-neutral-100" />
        ) : (
          <div
            className="h-full rounded-full bg-neutral-900 transition-[width] duration-200 ease-out motion-reduce:transition-none dark:bg-neutral-100"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {detail && (
        <span className="truncate text-xs text-neutral-400 dark:text-neutral-500">
          {detail}
        </span>
      )}
    </div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
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
