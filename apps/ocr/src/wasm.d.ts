// A Worker's bundle imports wasm compiled: Workers can't compile it from bytes at runtime.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
