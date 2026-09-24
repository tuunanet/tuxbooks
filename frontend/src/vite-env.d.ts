/// <reference types="vite/client" />

declare const __TUXBOOKS_VERSION__: string;

declare module "virtual:pdfium-wasm-url" {
  const wasmUrl: string;
  export default wasmUrl;
}
