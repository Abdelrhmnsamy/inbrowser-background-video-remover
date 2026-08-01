import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @huggingface/transformers pulls in optional native deps (sharp,
  // onnxruntime-node) that are only used server-side. We run the model entirely
  // in the browser, so keep the package out of the server bundle to avoid
  // trying to resolve those native modules at build time.
  serverExternalPackages: ["@huggingface/transformers"],

  async headers() {
    return [
      {
        // Let the browser cache the ONNX Runtime WASM/JS assets aggressively.
        // These are content-hashed and never change once fetched.
        source: "/:path*.(wasm|onnx)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
