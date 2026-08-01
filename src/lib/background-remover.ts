/**
 * Client-side background removal powered by Transformers.js (ONNX Runtime).
 *
 * Everything runs in the user's browser — the image never leaves the device.
 * The model weights are fetched once from the Hugging Face CDN on first use and
 * then cached by the browser, so subsequent runs are offline-capable.
 *
 * We prefer the WebGPU backend (fast, GPU-accelerated) and transparently fall
 * back to WASM (CPU) when WebGPU is unavailable.
 */

import {
  AutoModel,
  AutoProcessor,
  RawImage,
  env,
  type PreTrainedModel,
  type Processor,
} from "@huggingface/transformers";

// The model is downloaded from the Hugging Face Hub. Allow remote models and
// disable the local-model lookup (we don't ship weights ourselves).
env.allowLocalModels = false;

// RMBG-1.4 is the model used by Hugging Face's official "remove background in
// the browser with WebGPU" demo. It outputs a single-channel foreground mask
// and — unlike BiRefNet_lite — stays within the browser WebGPU limit of 10
// storage buffers per shader stage, so it runs on Apple/Metal GPUs where
// BiRefNet fails with "Too many storage buffers in shader".
const MODEL_ID = "briaai/RMBG-1.4";

export type Backend = "webgpu" | "wasm";

export type LoadProgress = {
  /** File currently being fetched, e.g. "onnx/model.onnx". */
  file: string;
  /** 0–100. */
  progress: number;
  /** Bytes loaded so far. */
  loaded: number;
  /** Total bytes for this file. */
  total: number;
};

export type LoadOptions = {
  onProgress?: (p: LoadProgress) => void;
};

// Minimal WebGPU shape — @webgpu/types isn't in the base tsconfig lib.
type MinimalGPU = { requestAdapter: () => Promise<unknown> };

/** Returns true if this browser exposes a usable WebGPU adapter. */
export async function isWebGPUAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: MinimalGPU }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

type LoadedModel = {
  model: PreTrainedModel;
  processor: Processor;
  backend: Backend;
};

// Module-level singleton so the (large) model is loaded at most once per tab.
let loadPromise: Promise<LoadedModel> | null = null;

async function loadModel(options: LoadOptions = {}): Promise<LoadedModel> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const webgpu = await isWebGPUAvailable();
    const backend: Backend = webgpu ? "webgpu" : "wasm";

    const progressCallback = (data: unknown) => {
      const d = data as {
        status?: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
      };
      if (d.status === "progress" && options.onProgress) {
        options.onProgress({
          file: d.file ?? "",
          progress: Math.round(d.progress ?? 0),
          loaded: d.loaded ?? 0,
          total: d.total ?? 0,
        });
      }
    };

    const model = await AutoModel.from_pretrained(MODEL_ID, {
      // fp16 on GPU is fast and accurate; fall back to fp32 on CPU/WASM.
      dtype: webgpu ? "fp16" : "fp32",
      device: backend,
      progress_callback: progressCallback,
    });

    const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback: progressCallback,
    });

    return { model, processor, backend };
  })();

  try {
    return await loadPromise;
  } catch (err) {
    // Let a later call retry if loading failed (e.g. transient network error).
    loadPromise = null;
    throw err;
  }
}

/** Which backend the model was loaded with, or null if not loaded yet. */
export async function getActiveBackend(): Promise<Backend | null> {
  if (!loadPromise) return null;
  try {
    return (await loadPromise).backend;
  } catch {
    return null;
  }
}

export type RemoveResult = {
  /** PNG blob with a transparent background. */
  blob: Blob;
  /** Object URL for the result blob. Caller is responsible for revoking it. */
  url: string;
  width: number;
  height: number;
  backend: Backend;
};

/**
 * Remove the background from an image.
 *
 * @param source A File/Blob, an object/remote URL, or an HTMLImageElement.
 */
export async function removeBackground(
  source: File | Blob | string | HTMLImageElement,
  options: LoadOptions = {},
): Promise<RemoveResult> {
  const { model, processor, backend } = await loadModel(options);

  // Decode the input into a RawImage (RGBA pixel buffer).
  const image = await toRawImage(source);

  // Preprocess -> run the model -> get the predicted foreground mask.
  // RMBG-1.4 takes `input` and returns `output` — a 0–1 foreground probability
  // map shaped [1, 1, H, W] (already sigmoid-activated, no extra sigmoid).
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });

  // Take the first batch item ([1, H, W]), scale 0–1 -> 0–255, and build a
  // single-channel mask resized back to the original resolution.
  const maskImage = await RawImage.fromTensor(
    output[0].mul(255).to("uint8"),
  ).resize(image.width, image.height);

  // Composite: copy the original RGB and use the mask as the alpha channel.
  const blob = await compositeAlpha(image, maskImage);
  const url = URL.createObjectURL(blob);

  return {
    blob,
    url,
    width: image.width,
    height: image.height,
    backend,
  };
}

// --- helpers -------------------------------------------------------------

async function toRawImage(
  source: File | Blob | string | HTMLImageElement,
): Promise<RawImage> {
  if (source instanceof HTMLImageElement) {
    return RawImage.fromURL(source.src);
  }
  if (typeof source === "string") {
    return RawImage.fromURL(source);
  }
  // File | Blob
  return RawImage.fromBlob(source);
}

/** Draw the RGB image and apply `mask` as the alpha channel; return a PNG. */
async function compositeAlpha(image: RawImage, mask: RawImage): Promise<Blob> {
  const rgba = image.clone().rgba(); // ensure 4 channels (RGBA)
  const maskGray = mask.clone().grayscale(); // ensure 1 channel

  const { width, height } = rgba;
  const src = rgba.data; // length width*height*4
  const maskData = maskGray.data; // length width*height

  // Copy into a fresh, tightly-packed RGBA buffer and overwrite the alpha
  // channel with the mask. Using a new array avoids buffer-offset surprises.
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = src[i * 4];
    out[i * 4 + 1] = src[i * 4 + 1];
    out[i * 4 + 2] = src[i * 4 + 2];
    out[i * 4 + 3] = maskData[i];
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");
  ctx.putImageData(new ImageData(out, width, height), 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas toBlob returned null"));
    }, "image/png");
  });
}
