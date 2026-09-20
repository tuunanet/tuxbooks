/// <reference types="vite/client" />

declare module "virtual:mupdf-wasm-url" {
  const wasmUrl: string;
  export default wasmUrl;
}

declare module "virtual:pdfium-wasm-url" {
  const wasmUrl: string;
  export default wasmUrl;
}
