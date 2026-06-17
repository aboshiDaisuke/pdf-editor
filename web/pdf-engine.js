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
    state.undo.push(saveBytes());
    let total = state.undo.reduce((a, b) => a + b.length, 0);
    while (state.undo.length > 1 && (state.undo.length > UNDO_MAX_COUNT || total > UNDO_MAX_BYTES)) {
      total -= state.undo.shift().length;
    }
    state.redo = [];
    state.dirty = true;
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
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 1024));
    if (!head.includes("%PDF-")) throw new Error("PDFファイルではないようです（対応形式は PDF のみ）");
    state.doc = openBytes(bytes);
    state.filename = filename || "document.pdf";
    state.dirty = false;
    state.undo = [];
    state.redo = [];
    return status();
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function renderPNG(idx, zoom) {
    const page = requirePage(idx);
    const pix = page.toPixmap(mupdf.Matrix.scale(clampZoom(zoom), clampZoom(zoom)),
      mupdf.ColorSpace.DeviceRGB, false, true);
    const png = pix.asPNG().slice();
    pix.destroy();
    return png;
  }

  function pageSizePts(idx) {
    const b = requirePage(idx).getBounds();
    return { w: b[2] - b[0], h: b[3] - b[1] };
  }

  // ── text extraction (display space) ──────────────────────────────────────
  function getText(idx) {
    const page = requirePage(idx);
    const st = page.toStructuredText("preserve-whitespace");
    const spans = [];
    let cur = null;
    const flush = () => { if (cur && cur.text.trim()) spans.push(cur); cur = null; };
    st.walk({
      beginLine() { flush(); },
      onChar(c, origin, font, size, quad, color) {
        const hexc = rgbToHex(color);
        const key = font.getName() + "|" + Math.round(size * 10) + "|" + hexc;
        if (!cur || cur.key !== key) {
          flush();
          cur = {
            key, text: "", size: Math.round(size * 10) / 10, font: font.getName(),
            color: hexc, origin: [origin[0], origin[1]],
            x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity,
          };
        }
        cur.text += c;
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        cur.x0 = Math.min(cur.x0, ...xs); cur.x1 = Math.max(cur.x1, ...xs);
        cur.y0 = Math.min(cur.y0, ...ys); cur.y1 = Math.max(cur.y1, ...ys);
      },
      endLine() { flush(); },
    });
    flush();
    st.destroy();
    return {
      spans: spans.map((s) => {
        const bbox = [s.x0, s.y0, s.x1, s.y1];
        return { text: s.text, size: s.size, font: s.font, color: s.color, bbox, dbox: bbox, origin: s.origin };
      }),
    };
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

  // ── FreeText insertion (used by add_text and edit_text reinsertion) ──────
  function insertFreeText(page, x, yTop, text, size, color) {
    // Width generous enough to avoid wrapping; CJK ~1em/char, latin narrower.
    const est = [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? size : size * 0.62), 0);
    const w = Math.max(est, 8) + size * 0.6;
    const ft = page.createAnnotation("FreeText");
    ft.setRect([x, yTop, x + w, yTop + size * 1.55]);
    ft.setDefaultAppearance("Helv", size, col(color));
    ft.setBorderWidth(0);
    try { ft.setColor([]); } catch (e) {}        // no border box
    ft.setContents(text);
    ft.update();
    return ft;
  }

  function editText(idx, bbox, origin, newText, fontSize, color) {
    snapshot();
    const page = requirePage(idx);
    const rect = norm(bbox[0], bbox[1], bbox[2], bbox[3]);
    // Remove ONLY the original glyphs, keep images / vector art underneath.
    const red = page.createAnnotation("Redact");
    red.setRect(rect);
    red.update();
    page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE,
      mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    // Re-insert near the original baseline/top-left.
    const size = Number(fontSize) || (rect[3] - rect[1]) || 12;
    insertFreeText(page, rect[0], rect[1] - size * 0.12, newText, size, color);
    return status();
  }

  function addText(idx, x, y, text, size, color, bg) {
    snapshot();
    const page = requirePage(idx);
    size = Number(size) || 14;
    if (bg && text) {
      const est = [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? size : size * 0.62), 0);
      const pad = size * 0.2;
      const fill = bg === true || bg === "white" ? [1, 1, 1] : col(bg, [1, 1, 1]);
      const sq = page.createAnnotation("Square");
      sq.setRect([x - pad, y - pad, x + est + pad, y + size + pad]);
      sq.setInteriorColor(fill);
      sq.setBorderWidth(0);
      try { sq.setColor([]); } catch (e) {}
      sq.update();
    }
    insertFreeText(page, x, y, text, size, color);
    return status();
  }

  // ── image (Stamp annotation) ─────────────────────────────────────────────
  function addImage(idx, x, y, w, imageBytes) {
    snapshot();
    const page = requirePage(idx);
    const img = new mupdf.Image(imageBytes);
    const iw = img.getWidth(), ih = img.getHeight();
    const h = w * ih / Math.max(1, iw);
    const st = page.createAnnotation("Stamp");
    st.setRect([x, y, x + w, y + h]);
    st.setStampImage(img);
    st.update();
    return status();
  }

  // ── vector shapes (Square / Circle / Line annotations) ───────────────────
  function drawShape(idx, type, x0, y0, x1, y1, color, width, fill) {
    snapshot();
    const page = requirePage(idx);
    width = Number(width) || 2;
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
  }

  // ── markup annotations ───────────────────────────────────────────────────
  function addAnnot(idx, p) {
    snapshot();
    const page = requirePage(idx);
    const kind = p.kind;
    const width = Number(p.width) || 2;
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

  function listAnnots(idx) {
    const page = requirePage(idx);
    const annots = page.getAnnotations();
    const out = [];
    annots.forEach((a, i) => {
      const t = a.getType();
      if (t === "Widget" || t === "Popup" || t === "Link" || t === "Redact") return;
      const r = a.getBounds();   // getRect() throws for Line/Ink (no Rect); getBounds works for all
      out.push({ xref: i, type: ANNOT_LABELS[t] || t || "注釈", rect: [r[0], r[1], r[2], r[3]] });
    });
    return { annots: out };
  }

  function deleteAnnot(idx, xref) {
    snapshot();
    const page = requirePage(idx);
    const annots = page.getAnnotations();
    const target = annots[xref];
    if (!target) throw new Error("注釈が見つかりません");
    page.deleteAnnotation(target);
    return status();
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
    const targets = pages == null ? [...Array(doc.countPages()).keys()]
      : pages.filter((p) => p >= 0 && p < doc.countPages());
    snapshot();
    for (const p of targets) {
      const obj = doc.loadPage(p).getObject();
      let cur = 0;
      const ro = obj.get("Rotate");
      if (ro && ro.isNumber && ro.isNumber()) cur = ro.asNumber();
      obj.put("Rotate", ((cur + step) % 360 + 360) % 360);
    }
    return status();
  }

  function importPdf(bytes, at) {
    const doc = requireDoc();
    const src = openBytes(bytes);
    const n = doc.countPages();
    let startAt = (Number.isInteger(at) && at >= 0) ? Math.min(at + 1, n) : n;
    snapshot();
    const count = src.countPages();
    for (let i = 0; i < count; i++) doc.graftPage(startAt + i, src, i);
    src.destroy && src.destroy();
    return status({ inserted: true });
  }

  function extract(pages) {
    const doc = requireDoc();
    const list = [...new Set((pages || []).filter((p) => p >= 0 && p < doc.countPages()))].sort((a, b) => a - b);
    if (!list.length) throw new Error("抽出するページがありません");
    const out = new mupdf.PDFDocument();
    for (let i = 0; i < list.length; i++) out.graftPage(i, doc, list[i]);
    const buf = out.saveToBuffer("compress");
    const bytes = buf.asUint8Array().slice();
    buf.destroy && buf.destroy();
    out.destroy && out.destroy();
    return { bytes, count: list.length };
  }

  // ── search (display space quads) ─────────────────────────────────────────
  function search(q) {
    const doc = requireDoc();
    q = (q || "").trim();
    if (!q) return { results: [], count: 0 };
    const results = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
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
    }
    return { results, count: results.length };
  }

  // ── form fields (widgets) ────────────────────────────────────────────────
  function getWidgets(idx) {
    const page = requirePage(idx);
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
  }

  const OFF = new Set([null, undefined, false, "", "Off", "off", "false", "No", "no", "0", 0]);

  function setWidget(idx, name, value) {
    const page = requirePage(idx);
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
  }

  // ── undo / redo (byte snapshots) ─────────────────────────────────────────
  function undo() {
    if (!state.undo.length) return status({ ok: false });
    state.redo.push(saveBytes());
    state.doc = openBytes(state.undo.pop());
    state.dirty = true;
    return status();
  }
  function redo() {
    if (!state.redo.length) return status({ ok: false });
    state.undo.push(saveBytes());
    state.doc = openBytes(state.redo.pop());
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
    addAnnot, listAnnots, deleteAnnot, addPage, deletePage, deletePages, movePage,
    rotate, importPdf, extract, search, getWidgets, setWidget, undo, redo, save, status,
    _state: state,
  };
}
