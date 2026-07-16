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
// Signal readiness explicitly. Loading mupdf.js + compiling the ~10MB wasm
// takes real time, and a postMessage the main thread fires immediately after
// `new Worker()` can arrive before this module has finished evaluating (and
// self.onmessage above is registered) — some browsers silently drop such
// early messages instead of queuing them. So the main thread waits for this
// id:0 message instead of racing an RPC call right after worker creation.
self.postMessage({ id: 0, ok: true });
