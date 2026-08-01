# Background Remover (Images & Video)

Remove the background from **images and videos entirely in your browser**. No
upload, no server, no account — your files never leave your device. Powered by
[Transformers.js](https://github.com/huggingface/transformers.js) running the
[RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) segmentation model through
ONNX Runtime, with **WebGPU** acceleration when your browser supports it (and an
automatic CPU/WASM fallback when it doesn't). Video is decoded and re-encoded
locally with [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).

Open source under the MIT license — clone it, host it, fork it.

## Images

1. Pick an image (drag-and-drop or file picker).
2. On first use, the AI model (RMBG-1.4, ONNX) downloads once from the
   Hugging Face CDN and is cached by your browser for next time.
3. The model runs locally to predict a foreground mask.
4. The mask becomes the alpha channel of the original image, and you download a
   transparent PNG.

## Video

Switch to the **Video** tab and drop any MP4, MOV, WebM, or MKV. The app:

1. Splits the video into individual PNG frames at the **exact source resolution
   and frame rate** (lossless intermediate, no frames dropped or duplicated).
2. Removes the background from each frame with RMBG-1.4 (frames are processed
   with a small amount of parallelism).
3. Composites your chosen **background** onto each frame — either **transparent**
   or a **solid color** (black by default; pick any color).
4. Re-assembles the frames into a **VP9 WebM** at the original frame rate and
   **muxes the original audio track back in**.

You choose the background with a color picker, and a **live preview of the first
frame** shows exactly what the result will look like before you commit to
processing the whole clip.

### A note on formats and "identical quality"

Removing a background means transparency, and the common video containers
(MP4/H.264, MOV, VP8) **cannot store an alpha channel**. The only single-file
format that keeps true transparency is **WebM (VP9 with alpha)**, so that is the
output. Because every frame must be decoded → processed → re-encoded, the output
is a fresh encode: **resolution and frame rate are preserved exactly**, and audio
is kept, but the codec/container change to VP9/WebM and the video is re-compressed
(you can raise quality by lowering the `-crf` value in
`src/lib/ffmpeg-video.ts`). Transparent WebM plays in Chrome, Edge, and Firefox.

Everything happens on your machine. There is no backend.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The first background removal will take a bit longer while the model weights
download (~a couple hundred MB, cached afterwards). With WebGPU, subsequent
images process in a second or two on a modern Mac.

The first background removal also downloads the FFmpeg.wasm core (~32MB, cached
afterwards) the first time you use the Video tab.

## Requirements

- A browser with **WebGPU** for best performance (Chrome/Edge 113+, or Safari 26+
  / Safari Technology Preview). Without WebGPU it still works on the CPU via
  WebAssembly — just slower. The app shows a badge telling you which backend is
  active.
- For video, any modern desktop browser works. The exported transparent WebM
  plays in **Chrome, Edge, and Firefox** (Safari's support for VP9-alpha WebM is
  limited). No cross-origin-isolation headers are required — the app uses the
  single-threaded FFmpeg core so it can be hosted anywhere.

## Build & deploy

```bash
npm run build
npm run start
```

Because it's a fully static, client-side app, you can deploy it to any static
host (Vercel, Netlify, GitHub Pages, Cloudflare Pages, etc.).

## Tech

- [Next.js 16](https://nextjs.org) (App Router) + React 19
- [Transformers.js](https://github.com/huggingface/transformers.js) v4
- [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) (ONNX)
- [FFmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (single-threaded core)
- Tailwind CSS v4

## Project layout

- `src/lib/background-remover.ts` — image model loading + inference + compositing
  (framework-agnostic; reusable in any browser project).
- `src/lib/ffmpeg-video.ts` — FFmpeg.wasm wrapper: probe, extract frames, encode
  the VP9-alpha WebM and mux audio.
- `src/lib/video-background-remover.ts` — the full video pipeline that ties the
  model and FFmpeg together (background compositing, first-frame preview,
  concurrency, progress).
- `src/app/page.tsx` — the tabbed shell (Image / Video).
- `src/app/ImagePanel.tsx`, `src/app/VideoPanel.tsx`, `src/app/ui.tsx` — the UI.

## Notes

`@huggingface/transformers` ships optional native Node dependencies (`sharp`,
`onnxruntime-node`) used only in server/Node contexts. This app never runs the
model on the server, so those are excluded from the server bundle via
`serverExternalPackages` in `next.config.ts`. Any `npm audit` warnings you see
originate from those unused Node-only dependencies, not the browser code path.

## License

[MIT](./LICENSE)
