// A Worker's bundle imports wasm compiled: Workers can't compile it from bytes at runtime.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// The compiler's own module has the package's types; only its entry (the Node shim) names them.
declare module "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs" {
  export * from "@myriaddreamin/typst-ts-web-compiler";
}
