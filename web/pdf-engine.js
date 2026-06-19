// PDF Editor — client-side engine backed by mupdf.js (WASM).
//
// Mirrors the semantics of the old Flask/PyMuPDF backend (server.py) but runs
// entirely in the browser. Every editing operation is expressed as a PDF
// annotation (FreeText for text, Square/Circle/Line for shapes, Stamp for
// images, plus the markup types) or a redaction — which keeps the code free of
// content-stream / coordinate / font-embedding gymnastics.
//
// Coordinate model: mupdf uses ONE space for rendering, structured-text,
// search AND annotations — the on-screen "display" space (rotation already
// applied), in PDF points. The UI works in exactly that space (mouse / zoom),
// so no rotation/derotation conversion is ever needed.
//
// Usage:
//   import * as mupdf from "./mupdf.js"          // browser
//   import * as mupdf from "mupdf"               // node (tests)
//   const engine = createEngine(mupdf)
//   engine.open(uint8, "file.pdf"); engine.renderPNG(0, 2); ...

export function createEngine(mupdf) {
  const UNDO_MAX_COUNT = 30;
  const UNDO_MAX_BYTES = 300 * 1024 * 1024;

  const state = {
    doc: null,
    filename: null,
    dirty: false,
    undo: [],
    redo: [],
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  const clampZoom = (z) => Math.max(0.1, Math.min(8, Number(z) || 2));
  const rectToQuad = (r) => [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]];
  const norm = (x0, y0, x1, y1) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  // Coerce to a number, but only fall back when the value is genuinely absent or
  // non-numeric — a legitimate 0 (e.g. a zero border width) must be preserved.
  const numOr = (v, def) => { const n = Number(v); return (v == null || v === "" || Number.isNaN(n)) ? def : n; };
  const textLines = (text) => String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const spanH = (s) => Math.max(0.1, s.bbox[3] - s.bbox[1]);
  const sameVisualLine = (line, s) => {
    const h = spanH(s), cy = (s.bbox[1] + s.bbox[3]) / 2;
    const overlap = Math.min(line.y1, s.bbox[3]) - Math.max(line.y0, s.bbox[1]);
    return overlap >= Math.min(line.h, h) * 0.35 || Math.abs(cy - line.cy) <= Math.max(2, Math.max(line.h, h) * 0.55);
  };
  const needsJoinSpace = (left, right, gap, size) => {
    if (gap <= Math.max(1, size * 0.45)) return false;
    if (!left || !right || /\s$/.test(left) || /^\s/.test(right)) return false;
    return /^[\x00-\x7f]$/.test(left.at(-1)) && /^[\x00-\x7f]$/.test(right[0]) &&
      /[0-9A-Za-z]/.test(left.at(-1)) && /[0-9A-Za-z]/.test(right[0]);
  };
  function mergeTextSpans(raw) {
    if (!raw.length) return [];
    const items = [...raw].sort((a, b) =>
      ((a.bbox[1] + a.bbox[3]) / 2 - (b.bbox[1] + b.bbox[3]) / 2) || (a.bbox[0] - b.bbox[0]));
    const lines = [];
    for (const s of items) {
      let line = lines.find((l) => sameVisualLine(l, s));
      if (!line) {
        const h = spanH(s);
        line = { chunks: [], y0: s.bbox[1], y1: s.bbox[3], cy: (s.bbox[1] + s.bbox[3]) / 2, h };
        lines.push(line);
      }
      line.chunks.push(s);
      line.y0 = Math.min(line.y0, s.bbox[1]);
      line.y1 = Math.max(line.y1, s.bbox[3]);
      line.cy = (line.y0 + line.y1) / 2;
      line.h = Math.max(line.h, spanH(s));
    }
    const merged = [];
    for (const line of lines.sort((a, b) => a.cy - b.cy)) {
      const chunks = line.chunks.sort((a, b) => a.bbox[0] - b.bbox[0]);
      const runs = [];
      let cur = [], last = null;
      for (const s of chunks) {
        if (last) {
          const gap = s.bbox[0] - last.bbox[2];
          const limit = Math.max(8, Math.max(last.size, s.size) * 2);
          if (gap > limit) { runs.push(cur); cur = []; }
        }
        cur.push(s);
        last = s;
      }
      if (cur.length) runs.push(cur);
      for (const run of runs) {
        let text = "";
        last = null;
        for (const s of run) {
          if (last && needsJoinSpace(text, s.text, s.bbox[0] - last.bbox[2], Math.max(last.size, s.size))) text += " ";
          text += s.text;
          last = s;
        }
        if (!text.trim()) continue;
        const bbox = [
          Math.min(...run.map((s) => s.bbox[0])),
          Math.min(...run.map((s) => s.bbox[1])),
          Math.max(...run.map((s) => s.bbox[2])),
          Math.max(...run.map((s) => s.bbox[3])),
        ];
        const first = run[0];
        merged.push({ text, size: Math.max(...run.map((s) => s.size)), font: first.font,
          color: first.color, bbox, dbox: bbox, origin: first.origin, parts: run.length });
      }
    }
    return merged;
  }

  function rgbToHex(c) {
    if (!c || c.length < 3) return "#000000";
    const h = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
    return "#" + h(c[0]) + h(c[1]) + h(c[2]);
  }
  // Accept either [r,g,b] 0..1 (preferred, what the UI sends) and pass through.
  function col(c, def) {
    if (Array.isArray(c) && c.length >= 3) return [c[0], c[1], c[2]];
    return def === undefined ? [0, 0, 0] : def;
  }

  function requireDoc() {
    if (!state.doc) throw new Error("ドキュメントが開かれていません");
    return state.doc;
  }
  function requirePage(idx) {
    const doc = requireDoc();
    if (!(idx >= 0 && idx < doc.countPages())) throw new Error(`ページ ${idx} は範囲外です`);
    return doc.loadPage(idx);
  }
  // loadPage() allocates a WASM-backed Page that mupdf only frees via the
  // FinalizationRegistry (non-deterministic, decoupled from the tiny JS handle).
  // Always destroy it eagerly so long sessions don't grow the WASM heap.
  function withPage(idx, fn) {
    const page = requirePage(idx);
    try { return fn(page); } finally { page.destroy && page.destroy(); }
  }
  // Replace the live document, eagerly freeing the previous one (a full PDF can
  // be hundreds of MB in WASM — don't wait for GC).
  function setDoc(doc) {
    const old = state.doc;
    state.doc = doc;
    if (old && old !== doc) old.destroy && old.destroy();
    return doc;
  }

  function validatePdfHeader(bytes) {
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 1024));
    if (!head.includes("%PDF-")) throw new Error("PDFファイルではないようです（対応形式は PDF のみ）");
  }

  function saveBytes(opts = "compress") {
    // IMPORTANT: asUint8Array() is a view into WASM memory that can be detached
    // when the Buffer is GC'd — copy it out immediately with slice().
    const buf = requireDoc().saveToBuffer(opts);
    const out = buf.asUint8Array().slice();
    buf.destroy && buf.destroy();
    return out;
  }

  function snapshot() {
    if (!state.doc) return;
    // Undo snapshots skip compression: every edit pays this serialize, and an
    // uncompressed write is far cheaper than a full deflate. The byte cap still
    // bounds memory; the final save() compresses.
    state.undo.push(saveBytes(""));
    let total = state.undo.reduce((a, b) => a + b.length, 0);
    while (state.undo.length > 1 && (state.undo.length > UNDO_MAX_COUNT || total > UNDO_MAX_BYTES)) {
      total -= state.undo.shift().length;
    }
    state.redo = [];
    state.dirty = true;
  }

  // Restore the document to the snapshot taken by the most recent snapshot()
  // call and discard that snapshot — used to roll back a destructive op (e.g.
  // editText's redaction) when a later step throws.
  function rollbackLastSnapshot() {
    const prev = state.undo.pop();
    if (prev) setDoc(openBytes(prev));
  }

  function openBytes(bytes) {
    return mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  }

  function status(extra) {
    const doc = state.doc;
    return Object.assign({
      ok: true,
      pages: doc ? doc.countPages() : 0,
      filename: state.filename,
      has_path: false,
      can_undo: state.undo.length > 0,
      can_redo: state.redo.length > 0,
      dirty: state.dirty,
    }, extra || {});
  }

  // ── open ─────────────────────────────────────────────────────────────────
  function open(bytes, filename) {
    validatePdfHeader(bytes);
    setDoc(openBytes(bytes));
    state.filename = filename || "document.pdf";
    state.dirty = false;
    state.undo = [];
    state.redo = [];
    return status();
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function renderPNG(idx, zoom) {
    return withPage(idx, (page) => {
      const pix = page.toPixmap(mupdf.Matrix.scale(clampZoom(zoom), clampZoom(zoom)),
        mupdf.ColorSpace.DeviceRGB, false, true);
      const png = pix.asPNG().slice();
      pix.destroy();
      return png;
    });
  }

  function pageSizePts(idx) {
    return withPage(idx, (page) => {
      const b = page.getBounds();
      return { w: b[2] - b[0], h: b[3] - b[1] };
    });
  }

  // ── text extraction (display space) ──────────────────────────────────────
  function getText(idx) {
    return withPage(idx, (page) => getTextForPage(page));
  }
  function getTextForPage(page) {
    const st = page.toStructuredText("preserve-whitespace");
    const raw = [];
    st.walk({
      onChar(c, origin, font, size, quad, color) {
        const hexc = rgbToHex(color);
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        raw.push({
          text: c,
          size: Math.round(size * 10) / 10,
          font: font.getName(),
          color: hexc,
          bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          origin: [origin[0], origin[1]],
        });
      },
    });
    st.destroy();
    return { spans: mergeTextSpans(raw) };
  }

  // Collect glyph quads whose centre falls inside a drag box (so markup hugs text).
  function charQuadsInBox(page, box) {
    const st = page.toStructuredText("preserve-whitespace");
    const quads = [];
    st.walk({
      onChar(c, origin, font, size, quad) {
        if (!c.trim()) return;
        const cx = (quad[0] + quad[6]) / 2, cy = (quad[1] + quad[5]) / 2;
        if (cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]) quads.push(quad);
      },
    });
    st.destroy();
    return quads;
  }

  // ── Real text insertion / movable text appearance ───────────────────────
  // Existing-text edits redraw into the page stream at the original baseline.
  // Newly added text is a FreeText annotation with a custom appearance so it can
  // be moved/resized while still using embedded CJK/local fonts.
  const FONT_SPECS = {
    jp:    { arg: "ja",          res: "FEjp" },     // Droid Sans Fallback (CJK + latin)
    sans:  { arg: "Helvetica",   res: "FEsans" },
    serif: { arg: "Times-Roman", res: "FEserif" },
    mono:  { arg: "Courier",     res: "FEmono" },
  };
  const localFonts = new Map();
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }
  function registerFont(id, label, data) {
    if (!id || !data) return;
    localFonts.set(id, { label: label || id, data });
  }
  function listFonts() {
    return [
      { id: "jp", label: "日本語（自動）", source: "app" },
      { id: "sans", label: "Helvetica", source: "builtin" },
      { id: "serif", label: "Times Roman", source: "builtin" },
      { id: "mono", label: "Courier", source: "builtin" },
      ...[...localFonts.entries()].map(([id, f]) => ({ id, label: f.label, source: "system" })),
    ];
  }
  // Embedded fonts live in the document, so cache per-document (a new doc from
  // open/undo/redo gets a fresh entry; the old one is GC'd with its document).
  const fontCache = new WeakMap();
  function embedFont(doc, fontKey) {
    let perDoc = fontCache.get(doc);
    if (!perDoc) { perDoc = new Map(); fontCache.set(doc, perDoc); }
    let ent = perDoc.get(fontKey);
    if (!ent) {
      let font, res;
      if (fontKey && localFonts.has(fontKey)) {
        const spec = localFonts.get(fontKey);
        font = new mupdf.Font(spec.label || "LocalFont", spec.data);
        res = "FElocal" + hashString(fontKey);
      } else {
        const spec = FONT_SPECS[fontKey] || FONT_SPECS.jp;
        font = new mupdf.Font(spec.arg);
        res = spec.res;
      }
      ent = { font, ref: doc.addFont(font), name: res };
      perDoc.set(fontKey, ent);
    }
    return ent;
  }

  // Inverse of an affine matrix [a b c d e f] (mupdf row-vector convention).
  function invertAffine(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c || 1e-9;
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    return [ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)];
  }
  const fmt = (n) => Number(n).toFixed(4).replace(/\.?0+$/, "") || "0";

  // Draw `text` at display-space baseline (dx, dy). Returns the text width in
  // points (for the optional whiteout box). Upright on rotated pages.
  function insertText(doc, page, dx, dy, text, size, color, fontKey) {
    const ent = embedFont(doc, fontKey);

    // Encode to glyph ids (Identity-encoded CID font: code == gid) + measure.
    const lines = textLines(text);
    const encoded = lines.map((line) => encodeLine(ent.font, line));
    const width = Math.max(0, ...encoded.map((l) => l.width * size));

    // Register the font in the page's resources (inheritable-aware so we never
    // shadow resources the existing content already relies on).
    const pd = page.getObject();
    let res = pd.getInheritable("Resources");
    if (!res || !res.isDictionary()) { res = doc.newDictionary(); pd.put("Resources", res); }
    let fonts = res.get("Font");
    if (!fonts || !fonts.isDictionary()) { fonts = doc.newDictionary(); res.put("Font", fonts); }
    fonts.put(ent.name, ent.ref);

    // Cancel the page transform with `cm` so we draw directly in display space,
    // then flip Y (display space is y-down, PDF text space is y-up).
    const cm = invertAffine(page.getTransform()).map(fmt).join(" ");
    const [cr, cg, cb] = col(color);
    const lineHeight = size * 1.22;
    const commands = encoded.map((line, i) =>
      `1 0 0 -1 ${fmt(dx)} ${fmt(dy + i * lineHeight)} Tm <${line.hex}> Tj`).join(" ");
    const stream = `q ${cm} cm BT /${ent.name} ${fmt(size)} Tf ` +
      `${fmt(cr)} ${fmt(cg)} ${fmt(cb)} rg ${commands} ET Q`;

    const buf = new mupdf.Buffer();
    buf.writeLine(stream);
    const streamObj = doc.addStream(buf, doc.newDictionary());

    // Append our stream after the existing content (never replace it).
    const arr = doc.newArray();
    const existing = pd.get("Contents");
    if (existing && existing.isArray()) {
      for (let i = 0; i < existing.length; i++) arr.push(existing.get(i));
    } else if (existing) {
      arr.push(existing);
    }
    arr.push(streamObj);
    pd.put("Contents", arr);
    page.update();
    return width;
  }

  function encodeLine(font, text) {
    let hex = "", width = 0;
    for (const ch of [...String(text ?? "")]) {
      const gid = font.encodeCharacter(ch.codePointAt(0));
      hex += gid.toString(16).padStart(4, "0");
      width += font.advanceGlyph(gid);
    }
    return { hex, width };
  }

  function textMetrics(font, text, size) {
    const lines = textLines(text);
    const widths = lines.map((line) => encodeLine(font, line).width * size);
    const lineHeight = size * 1.22;
    return {
      lines,
      widths,
      lineHeight,
      width: Math.max(1, ...widths),
      height: Math.max(size, lines.length * lineHeight),
    };
  }

  function setTextAppearance(doc, annot, text, size, color, bg, fontKey) {
    const ent = embedFont(doc, fontKey);
    const m = textMetrics(ent.font, text, size);
    const pad = Math.max(3, size * 0.22);
    const w = m.width + pad * 2;
    const h = m.height + pad * 2;
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put(ent.name, ent.ref);
    resources.put("Font", fonts);
    const [cr, cg, cb] = col(color);
    const chunks = [];
    if (bg) {
      const [br, bgc, bb] = bg === true || bg === "white" ? [1, 1, 1] : col(bg, [1, 1, 1]);
      chunks.push(`q ${fmt(br)} ${fmt(bgc)} ${fmt(bb)} rg 0 0 ${fmt(w)} ${fmt(h)} re f Q`);
    }
    chunks.push(`BT /${ent.name} ${fmt(size)} Tf ${fmt(cr)} ${fmt(cg)} ${fmt(cb)} rg`);
    textLines(text).forEach((line, i) => {
      const enc = encodeLine(ent.font, line);
      const y = h - pad - size - i * m.lineHeight;
      chunks.push(`1 0 0 1 ${fmt(pad)} ${fmt(y)} Tm <${enc.hex}> Tj`);
    });
    chunks.push("ET");
    const buf = new mupdf.Buffer();
    buf.writeLine(chunks.join(" "));
    annot.setAppearance("N", null, [1, 0, 0, 1, 0, 0], [0, 0, w, h], resources, buf);
    return { w, h };
  }

  function editText(idx, bbox, origin, newText, fontSize, color, fontKey) {
    snapshot();
    // applyRedactions is destructive (glyphs are gone before the new text goes
    // in). If anything below throws, roll the document back to the snapshot so a
    // failed edit can't silently lose the original content.
    try {
      return withPage(idx, (page) => {
        const rect = norm(bbox[0], bbox[1], bbox[2], bbox[3]);
        // Remove ONLY the original glyphs, keep images / vector art underneath.
        const red = page.createAnnotation("Redact");
        red.setRect(rect);
        red.update();
        page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE,
          mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
        // Re-insert at the ORIGINAL baseline (origin), not the bbox corner — the
        // bbox includes ascenders/descenders, so anchoring to it shifts the line.
        const size = numOr(fontSize, (rect[3] - rect[1]) || 12);
        const base = origin || [rect[0], rect[3]];
        insertText(state.doc, page, base[0], base[1], newText, size, color, fontKey || "jp");
        return status();
      });
    } catch (e) {
      rollbackLastSnapshot();
      throw e;
    }
  }

  function addText(idx, x, y, text, size, color, bg, fontKey) {
    snapshot();
    return withPage(idx, (page) => {
      size = numOr(size, 14);
      const doc = state.doc;
      const ent = embedFont(doc, fontKey || "jp");
      const m = textMetrics(ent.font, text, size);
      const pad = Math.max(3, size * 0.22);
      const w = m.width + pad * 2;
      const h = m.height + pad * 2;
      const a = page.createAnnotation("FreeText");
      a.setRect([x, y, x + w, y + h]);
      a.setContents(text || "");
      try { a.setDefaultAppearance("Helv", size, col(color)); } catch (e) {}
      try { a.setBorderWidth(0); } catch (e) {}
      a.update();
      setTextAppearance(doc, a, text, size, color, bg, fontKey || "jp");
      return status();
    });
  }

  // ── image (Stamp annotation) ─────────────────────────────────────────────
  function addImage(idx, x, y, w, imageBytes) {
    snapshot();
    return withPage(idx, (page) => {
      const img = new mupdf.Image(imageBytes);
      try {
        const iw = img.getWidth(), ih = img.getHeight();
        const h = w * ih / Math.max(1, iw);
        const st = page.createAnnotation("Stamp");
        st.setRect([x, y, x + w, y + h]);
        st.setStampImage(img);
        st.update();
      } finally {
        img.destroy && img.destroy();   // the image is copied into the PDF on update()
      }
      return status();
    });
  }

  // ── vector shapes (Square / Circle / Line annotations) ───────────────────
  function drawShape(idx, type, x0, y0, x1, y1, color, width, fill) {
    snapshot();
    return withPage(idx, (page) => {
      width = numOr(width, 2);
      if (type === "rect" || type === "ellipse") {
        const a = page.createAnnotation(type === "rect" ? "Square" : "Circle");
        a.setRect(norm(x0, y0, x1, y1));
        a.setColor(col(color));
        if (fill) a.setInteriorColor(col(fill));
        a.setBorderWidth(width);
        a.update();
      } else if (type === "line") {
        const a = page.createAnnotation("Line");
        a.setLine([x0, y0], [x1, y1]);
        a.setColor(col(color));
        a.setBorderWidth(width);
        a.update();
      } else {
        throw new Error("不明な図形です");
      }
      return status();
    });
  }

  // ── markup annotations ───────────────────────────────────────────────────
  function addAnnot(idx, p) {
    snapshot();
    return withPage(idx, (page) => addAnnotToPage(page, p));
  }
  function addAnnotToPage(page, p) {
    const kind = p.kind;
    const width = numOr(p.width, 2);
    if (kind === "highlight" || kind === "underline" || kind === "strikeout") {
      const box = norm(p.x0, p.y0, p.x1, p.y1);
      let quads = charQuadsInBox(page, box);
      if (!quads.length) quads = [rectToQuad(box)];
      const type = kind === "highlight" ? "Highlight" : kind === "underline" ? "Underline" : "StrikeOut";
      const a = page.createAnnotation(type);
      a.setQuadPoints(quads);
      a.setColor(col(p.color, [1, 0.85, 0]));
      a.update();
    } else if (kind === "ink") {
      const strokes = (p.strokes || []).filter((s) => s.length > 1).map((s) => s.map((pt) => [pt[0], pt[1]]));
      if (!strokes.length) throw new Error("描画データがありません");
      const a = page.createAnnotation("Ink");
      a.setInkList(strokes);
      a.setColor(col(p.color, [0, 0, 0]));
      a.setBorderWidth(width);
      a.update();
    } else if (kind === "arrow" || kind === "line") {
      const a = page.createAnnotation("Line");
      a.setLine([p.x0, p.y0], [p.x1, p.y1]);
      if (kind === "arrow") a.setLineEndingStyles("None", "OpenArrow");
      a.setColor(col(p.color, [0.9, 0.1, 0.1]));
      a.setBorderWidth(width);
      a.update();
    } else if (kind === "note") {
      const x = Number(p.x) || 50, y = Number(p.y) || 50;
      const a = page.createAnnotation("Text");
      a.setRect([x, y, x + 18, y + 18]);
      a.setContents(p.text || "");
      a.setColor(col(p.color, [1, 0.9, 0.2]));
      a.update();
    } else {
      throw new Error("不明な注釈です");
    }
    return status();
  }

  const ANNOT_LABELS = {
    Highlight: "ハイライト", Underline: "下線", StrikeOut: "取り消し線",
    Ink: "フリーハンド", Line: "直線/矢印", Text: "コメント",
    Square: "四角", Circle: "楕円", FreeText: "テキスト", Stamp: "画像",
  };
  // Annotation kinds that have a meaningful /Rect and can be moved/resized.
  const RECT_EDITABLE = new Set(["Stamp", "Square", "Circle", "FreeText", "Text"]);

  function listAnnots(idx) {
    return withPage(idx, (page) => {
      const annots = page.getAnnotations();
      const out = [];
      annots.forEach((a, i) => {
        const t = a.getType();
        if (t === "Widget" || t === "Popup" || t === "Link" || t === "Redact") return;
        // Report the core /Rect for rect-editable kinds (so select→setRect round-trips
        // exactly), but getBounds for Line/Ink which have no Rect (getRect throws).
        let r;
        try { r = RECT_EDITABLE.has(t) ? a.getRect() : a.getBounds(); }
        catch (e) { r = a.getBounds(); }
        // xref is the index into getAnnotations(); deleteAnnot/setAnnotRect index
        // the same array, so they stay in lock-step (skipped types still consume a slot).
        out.push({ xref: i, kind: t, type: ANNOT_LABELS[t] || t || "注釈", rect: [r[0], r[1], r[2], r[3]] });
      });
      return { annots: out };
    });
  }

  function deleteAnnot(idx, xref) {
    snapshot();
    return withPage(idx, (page) => {
      const annots = page.getAnnotations();
      const target = annots[xref];
      if (!target) throw new Error("注釈が見つかりません");
      page.deleteAnnotation(target);
      return status();
    });
  }

  // Move/resize a rect-based annotation (Stamp/Square/Circle/FreeText/Text) by
  // rewriting its Rect. xref is the getAnnotations() index, as in listAnnots.
  // Validate BEFORE snapshot so a rejected edit doesn't push a no-op undo state
  // or mark the document dirty.
  function setAnnotRect(idx, xref, rect) {
    return withPage(idx, (page) => {
      const a = page.getAnnotations()[xref];
      if (!a) throw new Error("注釈が見つかりません");
      if (!RECT_EDITABLE.has(a.getType())) throw new Error("この注釈は移動・リサイズに対応していません");
      snapshot();
      a.setRect(norm(rect[0], rect[1], rect[2], rect[3]));
      a.update();
      return status();
    });
  }

  // ── page organisation ────────────────────────────────────────────────────
  function addPage() {
    const doc = requireDoc();
    snapshot();
    const obj = doc.addPage([0, 0, 595, 842], 0, doc.newDictionary(), "");
    doc.insertPage(doc.countPages(), obj);
    return status();
  }

  function deletePage(idx) {
    const doc = requireDoc();
    if (doc.countPages() <= 1) throw new Error("最後のページは削除できません");
    if (!(idx >= 0 && idx < doc.countPages())) throw new Error("ページが範囲外です");
    snapshot();
    doc.deletePage(idx);
    return status();
  }

  function deletePages(pages) {
    const doc = requireDoc();
    const list = [...new Set((pages || []).filter((p) => p >= 0 && p < doc.countPages()))].sort((a, b) => b - a);
    if (!list.length) throw new Error("削除するページがありません");
    if (list.length >= doc.countPages()) throw new Error("すべてのページは削除できません");
    snapshot();
    for (const p of list) doc.deletePage(p);
    return status({ deleted: list.length });
  }

  function movePage(from, to) {
    const doc = requireDoc();
    const n = doc.countPages();
    if (!(from >= 0 && from < n)) throw new Error("移動元が範囲外です");
    snapshot();
    const order = [...Array(n).keys()];
    const [item] = order.splice(from, 1);
    let t = to > from ? to - 1 : to;       // index shifts after removal
    if (to >= n) t = order.length;          // "past the end" -> append
    if (t < 0) t = 0;
    if (t > order.length) t = order.length;
    order.splice(t, 0, item);
    doc.rearrangePages(order);
    return status();
  }

  function rotate(pages, dir) {
    const doc = requireDoc();
    const step = (Number(dir) >= 0 ? 90 : -90);
    const targets = Array.isArray(pages) ? [...new Set(pages)].filter((p) => p >= 0 && p < doc.countPages()) : [];
    if (!targets.length) return status();
    snapshot();
    for (const p of targets) {
      withPage(p, (page) => {
        const obj = page.getObject();
        // /Rotate is inheritable: read it resolved up the Pages tree, not just
        // the direct key, so a page that inherits its rotation isn't reset to 0.
        let cur = 0;
        const ro = obj.getInheritable("Rotate");
        if (ro && ro.isNumber && ro.isNumber()) cur = ro.asNumber();
        ro && ro.destroy && ro.destroy();
        obj.put("Rotate", ((cur + step) % 360 + 360) % 360);
        obj.destroy && obj.destroy();
      });
    }
    return status();
  }

  function importPdf(bytes, at) {
    const doc = requireDoc();
    validatePdfHeader(bytes);
    const src = openBytes(bytes);
    try {
      const n = doc.countPages();
      let startAt = (Number.isInteger(at) && at >= 0) ? Math.min(at + 1, n) : n;
      snapshot();
      const count = src.countPages();
      for (let i = 0; i < count; i++) doc.graftPage(startAt + i, src, i);
    } finally {
      src.destroy && src.destroy();   // freed even if a graft throws mid-loop
    }
    return status({ inserted: true });
  }

  function extract(pages) {
    const doc = requireDoc();
    const list = [...new Set((pages || []).filter((p) => p >= 0 && p < doc.countPages()))].sort((a, b) => a - b);
    if (!list.length) throw new Error("抽出するページがありません");
    // NOTE: graftPage copies pages only — document-level data (AcroForm fields,
    // outlines) is intentionally not carried into the extracted file.
    const out = new mupdf.PDFDocument();
    try {
      for (let i = 0; i < list.length; i++) out.graftPage(i, doc, list[i]);
      const buf = out.saveToBuffer("compress");
      const bytes = buf.asUint8Array().slice();
      buf.destroy && buf.destroy();
      return { bytes, count: list.length };
    } finally {
      out.destroy && out.destroy();   // freed even if a graft/save throws
    }
  }

  // ── search (display space quads) ─────────────────────────────────────────
  function search(q) {
    const doc = requireDoc();
    q = (q || "").trim();
    if (!q) return { results: [], count: 0 };
    const results = [];
    for (let i = 0; i < doc.countPages(); i++) {
      withPage(i, (page) => {
        let hits = [];
        try { hits = page.search(q); } catch (e) { hits = []; }
        for (const match of hits) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const quad of match) {
            const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
            x0 = Math.min(x0, ...xs); x1 = Math.max(x1, ...xs);
            y0 = Math.min(y0, ...ys); y1 = Math.max(y1, ...ys);
          }
          if (x1 > x0) results.push({ page: i, rect: [x0, y0, x1, y1] });
        }
      });
    }
    return { results, count: results.length };
  }

  // ── form fields (widgets) ────────────────────────────────────────────────
  function getWidgets(idx) {
    return withPage(idx, (page) => {
      const widgets = page.getWidgets().map((w) => {
        let options = null;
        try { if (w.isChoice && w.isChoice()) options = w.getOptions(); } catch (e) {}
        const r = w.getRect();
        return {
          name: w.getName(),
          type: w.getFieldType(),
          value: w.getValue(),
          rect: [r[0], r[1], r[2], r[3]],
          options: options && options.length ? options : null,
        };
      });
      return { widgets };
    });
  }

  // The canonical PDF "off" appearance state is /Off. Keep this set to the real
  // off values only — including "0"/0 here would wrongly read a checkbox whose
  // on-state export value is "0" as unchecked.
  const OFF = new Set([null, undefined, false, "", "Off", "off"]);

  function setWidget(idx, name, value) {
    if (value === undefined) throw new Error("値がありません");
    return withPage(idx, (page) => {
      const targets = page.getWidgets().filter((w) => w.getName() === name);
      if (!targets.length) throw new Error("フィールドが見つかりません");
      snapshot();
      for (const w of targets) {
        if (w.isCheckbox && w.isCheckbox()) {
          const want = !OFF.has(value);
          const isOn = !OFF.has(w.getValue());
          if (want !== isOn) w.toggle();
        } else if (w.isChoice && w.isChoice()) {
          w.setChoiceValue(String(value));
        } else {
          w.setTextValue(String(value));
        }
        w.update();
      }
      return status();
    });
  }

  // ── undo / redo (byte snapshots) ─────────────────────────────────────────
  function undo() {
    if (!state.undo.length) return status({ ok: false });
    state.redo.push(saveBytes(""));
    setDoc(openBytes(state.undo.pop()));   // frees the doc being replaced
    state.dirty = true;
    return status();
  }
  function redo() {
    if (!state.redo.length) return status({ ok: false });
    state.undo.push(saveBytes(""));
    setDoc(openBytes(state.redo.pop()));
    state.dirty = true;
    return status();
  }

  // ── save ─────────────────────────────────────────────────────────────────
  function save() {
    requireDoc();
    try { state.doc.subsetFonts(); } catch (e) {}
    const bytes = saveBytes("compress");
    state.dirty = false;
    return bytes;
  }

  return {
    open, renderPNG, pageSizePts, getText, editText, addText, addImage, drawShape,
    listFonts, registerFont,
    addAnnot, listAnnots, deleteAnnot, setAnnotRect, addPage, deletePage, deletePages, movePage,
    rotate, importPdf, extract, search, getWidgets, setWidget, undo, redo, save, status,
    _state: state,
  };
}
