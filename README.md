# Background Remover

Remove the background from any image **entirely in your browser**. No upload, no
server, no account — the image never leaves your device. Powered by
[Transformers.js](https://github.com/huggingface/transformers.js) running the
[RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) segmentation model through
ONNX Runtime, with **WebGPU** acceleration when your browser supports it (and an
automatic CPU/WASM fallback when it doesn't).

Open source under the MIT license — clone it, host it, fork it.

## How it works

1. You pick an image (drag-and-drop or file picker).
2. On first use, the AI model (RMBG-1.4, ONNX) downloads once from the
   Hugging Face CDN and is cached by your browser for next time.
3. The model runs locally to predict a foreground mask.
4. The mask becomes the alpha channel of the original image, and you download a
   transparent PNG.

Everything in steps 2–4 happens on your machine. There is no backend.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The first background removal will take a bit longer while the model weights
download (~a couple hundred MB, cached afterwards). With WebGPU, subsequent
images process in a second or two on a modern Mac.

## Requirements

- A browser with **WebGPU** for best performance (Chrome/Edge 113+, or Safari 26+
  / Safari Technology Preview). Without WebGPU it still works on the CPU via
  WebAssembly — just slower. The app shows a badge telling you which backend is
  active.

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
- Tailwind CSS v4

## Project layout

- `src/lib/background-remover.ts` — the model loading + inference + compositing
  logic (framework-agnostic; reusable in any browser project).
- `src/app/page.tsx` — the UI (drag-drop, progress, before/after, download).

## Notes

`@huggingface/transformers` ships optional native Node dependencies (`sharp`,
`onnxruntime-node`) used only in server/Node contexts. This app never runs the
model on the server, so those are excluded from the server bundle via
`serverExternalPackages` in `next.config.ts`. Any `npm audit` warnings you see
originate from those unused Node-only dependencies, not the browser code path.

## License

[MIT](./LICENSE)
