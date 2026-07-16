// Module worker: hosts mupdf WASM + the engine so heavy ops don't block the UI.
import * as mupdf from "./mupdf.js";
import { createEngine } from "./pdf-engine.js";

const engine = createEngine(mupdf);

self.onmessage = (e) => {
  const { id, fn, args } = e.data;
  try {
    if (typeof engine[fn] !== 'function') throw new Error(`unknown engine function: ${fn}`);
    const result = engine[fn](...args);
    const transfers = [];
    collectTransfers(result, transfers);
    self.postMessage({ id, ok: true, result }, transfers);
  } catch (err) {
    self.postMessage({ id, ok: false, message: String((err && err.message) || err),
      needPassword: !!(err && err.needPassword) });
  }
};
function collectTransfers(v, out) {
  if (!v) return;
  if (v instanceof Uint8Array) { out.push(v.buffer); return; }
  if (typeof v === 'object') for (const k in v) collectTransfers(v[k], out);
}
