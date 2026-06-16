"""PDF Editor — Flask + PyMuPDF backend (Acrobat-like, standalone desktop app).

All access to the shared document goes through LOCK (PyMuPDF Documents are not
thread-safe and Flask's dev server is threaded). Every API handler is wrapped so
that exceptions become clean JSON errors instead of unhandled 500s.
"""

from flask import Flask, request, jsonify, send_file
import pymupdf
import io
import os
import sys
import functools
import threading

# ── Base path (works for dev and PyInstaller bundle) ──
if getattr(sys, "_MEIPASS", None):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500MB

# ── Embeddable Unicode font (covers Japanese + Latin). Subset on save. ──
JP_ALIAS = "uifont"
_JP_CANDIDATES = [
    os.path.join(BASE_DIR, "NotoSansJP-Regular.ttf"),
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]


def _resolve_font():
    for p in _JP_CANDIDATES:
        if os.path.exists(p):
            try:
                pymupdf.Font(fontfile=p)  # validate it loads
                return p
            except Exception:
                continue
    return None


JP_FONT_FILE = _resolve_font()


def insert_text(page, point, text, size, color):
    """Insert text with the embedded Unicode font when available."""
    if JP_FONT_FILE:
        page.insert_text(point, text, fontsize=size, fontname=JP_ALIAS,
                         fontfile=JP_FONT_FILE, color=color)
    else:  # graceful fallback (non-embedded CID font)
        page.insert_text(point, text, fontsize=size, fontname="japan", color=color)


# ── Shared state (guarded by LOCK) ──
LOCK = threading.RLock()
state = {
    "doc": None,
    "filename": None,      # display name
    "filepath_real": None, # real disk path (None when opened from an upload)
    "undo_stack": [],
    "redo_stack": [],
    "dirty": False,
}


class ApiError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


def require_doc():
    doc = state["doc"]
    if not doc:
        raise ApiError("ドキュメントが開かれていません", 400)
    return doc


def require_page(idx):
    doc = require_doc()
    if not (0 <= idx < len(doc)):
        raise ApiError(f"ページ {idx} は範囲外です", 404)
    return doc, doc[idx]


def push_undo():
    """Snapshot the document for undo. Correct and simple; O(doc size) per edit."""
    if not state["doc"]:
        return
    state["undo_stack"].append(state["doc"].tobytes())
    if len(state["undo_stack"]) > 30:
        state["undo_stack"].pop(0)
    state["redo_stack"].clear()
    state["dirty"] = True


def status(**extra):
    doc = state["doc"]
    base = {
        "ok": True,
        "pages": len(doc) if doc else 0,
        "filename": state["filename"],
        "has_path": bool(state["filepath_real"]),
        "can_undo": bool(state["undo_stack"]),
        "can_redo": bool(state["redo_stack"]),
        "dirty": state["dirty"],
    }
    base.update(extra)
    return jsonify(base)


def api(rule, **options):
    """Register a handler that runs under LOCK with uniform error handling."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with LOCK:
                try:
                    return fn(*args, **kwargs)
                except ApiError as e:
                    return jsonify(error=str(e)), e.code
                except Exception as e:  # never leak an unhandled 500 to the UI
                    app.logger.exception("API error in %s", fn.__name__)
                    return jsonify(error=str(e)), 500
        app.add_url_rule(rule, fn.__name__, wrapper, **options)
        return wrapper
    return decorator


def rgb(color, default=(0, 0, 0)):
    if not color:
        return default
    return tuple(float(c) for c in color[:3])


# ── Static ──
@app.route("/")
def index():
    return send_file(os.path.join(BASE_DIR, "app.html"))


# ── Open / state ──
def _load_stream(data, filename, real_path=None):
    state["doc"] = pymupdf.open(stream=data, filetype="pdf")
    state["filename"] = filename
    state["filepath_real"] = real_path
    state["undo_stack"].clear()
    state["redo_stack"].clear()
    state["dirty"] = False


@api("/api/open", methods=["POST"])
def open_pdf():
    """Open from a browser upload (drag & drop). No real disk path -> save-as only."""
    f = request.files.get("file")
    if not f:
        raise ApiError("ファイルがありません")
    _load_stream(f.read(), f.filename, real_path=None)
    return status()


@api("/api/open_path", methods=["POST"])
def open_path():
    """Open from a real disk path chosen via the native dialog."""
    d = request.get_json(silent=True) or {}
    path = d.get("path")
    if not path or not os.path.isfile(path):
        raise ApiError("ファイルが見つかりません")
    with open(path, "rb") as fh:
        _load_stream(fh.read(), os.path.basename(path), real_path=path)
    return status()


@api("/api/state")
def get_state():
    return status()


# ── Render ──
@api("/api/page/<int:idx>")
def get_page(idx):
    doc, page = require_page(idx)
    zoom = max(0.1, min(8.0, float(request.args.get("zoom", 2))))
    mat = pymupdf.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False, annots=True)
    buf = io.BytesIO(pix.tobytes("png"))
    buf.seek(0)
    return send_file(buf, mimetype="image/png")


@api("/api/page_size/<int:idx>")
def page_size(idx):
    doc, page = require_page(idx)
    r = page.rect
    return jsonify(width=r.width, height=r.height, rotation=page.rotation)


# ── Text extraction (for the text-edit list) ──
@api("/api/text/<int:idx>")
def get_text(idx):
    doc, page = require_page(idx)
    spans = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b.get("lines", []):
            for sp in ln.get("spans", []):
                if not sp.get("text", "").strip():
                    continue
                c = sp.get("color", 0)
                if isinstance(c, int):
                    hexc = f"#{(c >> 16) & 0xFF:02x}{(c >> 8) & 0xFF:02x}{c & 0xFF:02x}"
                else:
                    hexc = "#000000"
                spans.append({
                    "text": sp["text"],
                    "size": round(sp["size"], 1),
                    "font": sp.get("font", ""),
                    "color": hexc,
                    "bbox": list(sp["bbox"]),
                    "origin": list(sp.get("origin", (sp["bbox"][0], sp["bbox"][3]))),
                })
    return jsonify(spans=spans)


def _bg_color(page, rect):
    """Average the border ring just outside the text so the erase blends in."""
    clip = rect + (-3, -3, 3, 3)
    pix = page.get_pixmap(clip=clip, alpha=False)
    w, h = pix.width, pix.height
    if w < 2 or h < 2:
        r, g, b = pix.pixel(0, 0)
        return (r / 255, g / 255, b / 255)
    samples = []
    for x in range(w):
        samples.append(pix.pixel(x, 0))
        samples.append(pix.pixel(x, h - 1))
    for y in range(h):
        samples.append(pix.pixel(0, y))
        samples.append(pix.pixel(w - 1, y))
    n = len(samples)
    return (sum(s[0] for s in samples) / n / 255,
            sum(s[1] for s in samples) / n / 255,
            sum(s[2] for s in samples) / n / 255)


@api("/api/edit_text", methods=["POST"])
def edit_text():
    d = request.get_json(silent=True) or {}
    idx = d.get("page")
    if idx is None or "bbox" not in d or "new_text" not in d:
        raise ApiError("不正なリクエストです")
    doc, page = require_page(idx)
    bbox = d["bbox"]
    new_text = d["new_text"]
    font_size = float(d.get("font_size", 12))
    color = rgb(d.get("color"))

    push_undo()
    rect = pymupdf.Rect(bbox)
    # Erase the original text by filling with the surrounding background colour.
    page.add_redact_annot(rect, fill=_bg_color(page, rect))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)

    # Re-insert at the original baseline (origin) so the position is preserved.
    origin = d.get("origin") or [rect.x0, rect.y1]
    insert_text(page, pymupdf.Point(origin[0], origin[1]), new_text, font_size, color)
    return status()


@api("/api/add_text", methods=["POST"])
def add_text():
    d = request.get_json(silent=True) or {}
    idx = d.get("page")
    text = d.get("text", "")
    if idx is None:
        raise ApiError("不正なリクエストです")
    doc, page = require_page(idx)
    size = float(d.get("size", 14))
    push_undo()
    # Treat the click point as the visual top-left: drop the baseline by the size.
    insert_text(page, pymupdf.Point(d.get("x", 50), d.get("y", 50) + size),
                text, size, rgb(d.get("color")))
    return status()


# ── Images (with compression before embedding) ──
def _prep_image(img_data, w_pt):
    from PIL import Image
    img = Image.open(io.BytesIO(img_data))
    iw, ih = img.size
    target = max(1, int(w_pt / 72 * 200))  # ~200 DPI at the placed width
    if iw > target * 1.3:
        scale = target / iw
        img = img.resize((max(1, int(iw * scale)), max(1, int(ih * scale))), Image.LANCZOS)
    out = io.BytesIO()
    if img.mode in ("RGBA", "LA", "P"):
        img.convert("RGBA").save(out, "PNG", optimize=True)
    else:
        img.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
    return out.getvalue(), iw, ih


@api("/api/add_image", methods=["POST"])
def add_image():
    f = request.files.get("image")
    if not f:
        raise ApiError("画像ファイルがありません")
    page_idx = int(request.form.get("page", 0))
    x = float(request.form.get("x", 50))
    y = float(request.form.get("y", 50))
    w = float(request.form.get("w", 200))
    doc, page = require_page(page_idx)
    raw = f.read()
    try:
        stream, iw, ih = _prep_image(raw, w)
    except Exception:
        raise ApiError("画像を読み込めませんでした（対応していない形式の可能性があります）")
    push_undo()
    h = w * ih / iw
    page.insert_image(pymupdf.Rect(x, y, x + w, y + h), stream=stream)
    return status()


# ── Vector shapes (burned into page content) ──
@api("/api/draw_shape", methods=["POST"])
def draw_shape():
    d = request.get_json(silent=True) or {}
    idx = d.get("page")
    shape = d.get("type")
    if idx is None or shape is None or "x0" not in d:
        raise ApiError("不正なリクエストです")
    doc, page = require_page(idx)
    color = rgb(d.get("color"))
    width = float(d.get("width", 2))
    fill = rgb(d["fill"]) if d.get("fill") else None
    push_undo()
    if shape == "rect":
        page.draw_rect(pymupdf.Rect(d["x0"], d["y0"], d["x1"], d["y1"]),
                       color=color, fill=fill, width=width)
    elif shape == "ellipse":
        page.draw_oval(pymupdf.Rect(d["x0"], d["y0"], d["x1"], d["y1"]),
                       color=color, fill=fill, width=width)
    elif shape == "line":
        page.draw_line(pymupdf.Point(d["x0"], d["y0"]),
                       pymupdf.Point(d["x1"], d["y1"]), color=color, width=width)
    else:
        raise ApiError("不明な図形です")
    return status()


# ── Annotations (Acrobat-style markup, editable in the saved PDF) ──
@api("/api/annot", methods=["POST"])
def add_annot():
    d = request.get_json(silent=True) or {}
    idx = d.get("page")
    kind = d.get("kind")
    if idx is None or kind is None:
        raise ApiError("不正なリクエストです")
    doc, page = require_page(idx)
    color = rgb(d.get("color"), default=(1, 0.85, 0))
    width = float(d.get("width", 2))
    push_undo()

    if kind in ("highlight", "underline", "strikeout"):
        rect = pymupdf.Rect(d["x0"], d["y0"], d["x1"], d["y1"])
        # Prefer real text quads so the markup hugs the glyphs (true Acrobat behaviour).
        quads = [pymupdf.Rect(w[:4]).quad for w in page.get_text("words")
                 if pymupdf.Rect(w[:4]).intersects(rect)]
        target = quads if quads else [rect.quad]
        fn = {"highlight": page.add_highlight_annot,
              "underline": page.add_underline_annot,
              "strikeout": page.add_strikeout_annot}[kind]
        annot = fn(target)
        annot.set_colors(stroke=color)
        annot.update()
    elif kind == "ink":
        strokes = d.get("strokes") or []
        strokes = [[(float(p[0]), float(p[1])) for p in s] for s in strokes if len(s) > 1]
        if not strokes:
            raise ApiError("描画データがありません")
        annot = page.add_ink_annot(strokes)
        annot.set_colors(stroke=rgb(d.get("color"), default=(0, 0, 0)))
        annot.set_border(width=width)
        annot.update()
    elif kind in ("arrow", "line"):
        annot = page.add_line_annot(pymupdf.Point(d["x0"], d["y0"]),
                                    pymupdf.Point(d["x1"], d["y1"]))
        if kind == "arrow":
            annot.set_line_ends(pymupdf.PDF_ANNOT_LE_NONE, pymupdf.PDF_ANNOT_LE_OPEN_ARROW)
        annot.set_colors(stroke=rgb(d.get("color"), default=(0.9, 0.1, 0.1)))
        annot.set_border(width=width)
        annot.update()
    elif kind == "note":
        annot = page.add_text_annot(pymupdf.Point(d.get("x", 50), d.get("y", 50)),
                                    d.get("text", ""))
        annot.set_colors(stroke=rgb(d.get("color"), default=(1, 0.9, 0.2)))
        annot.update()
    else:
        raise ApiError("不明な注釈です")
    return status()


# ── Page organisation ──
@api("/api/add_page", methods=["POST"])
def add_page():
    doc = require_doc()
    push_undo()
    doc.new_page(pno=-1, width=595, height=842)
    return status()


@api("/api/delete_page", methods=["POST"])
def delete_page():
    doc = require_doc()
    if len(doc) <= 1:
        raise ApiError("最後のページは削除できません")
    d = request.get_json(silent=True) or {}
    idx = d.get("page")
    if idx is None or not (0 <= idx < len(doc)):
        raise ApiError("ページが範囲外です", 404)
    push_undo()
    doc.delete_page(idx)
    return status()


@api("/api/delete_pages", methods=["POST"])
def delete_pages():
    doc = require_doc()
    d = request.get_json(silent=True) or {}
    pages = sorted({p for p in (d.get("pages") or []) if 0 <= p < len(doc)}, reverse=True)
    if not pages:
        raise ApiError("削除するページがありません")
    if len(pages) >= len(doc):
        raise ApiError("すべてのページは削除できません")
    push_undo()
    for p in pages:
        doc.delete_page(p)
    return status(deleted=len(pages))


@api("/api/move_page", methods=["POST"])
def move_page():
    doc = require_doc()
    d = request.get_json(silent=True) or {}
    frm = d.get("from")
    to = d.get("to")
    if frm is None or to is None:
        raise ApiError("不正なリクエストです")
    n = len(doc)
    if not (0 <= frm < n):
        raise ApiError("移動元が範囲外です", 404)
    # PyMuPDF inserts BEFORE `to`; valid range is -1..n. Clamp "past the end" to -1.
    if to >= n:
        to = -1
    elif to < -1:
        to = 0
    push_undo()
    doc.move_page(frm, to)
    return status()


@api("/api/rotate", methods=["POST"])
def rotate_pages():
    doc = require_doc()
    d = request.get_json(silent=True) or {}
    step = 90 if int(d.get("dir", 1)) >= 0 else -90
    pages = d.get("pages")
    targets = [p for p in pages if 0 <= p < len(doc)] if pages else range(len(doc))
    push_undo()
    for p in targets:
        page = doc[p]
        page.set_rotation((page.rotation + step) % 360)
    return status()


@api("/api/import_pdf", methods=["POST"])
def import_pdf():
    """Insert all pages of another PDF after a given index."""
    doc = require_doc()
    d = request.get_json(silent=True) or {}
    path = d.get("path")
    if not path or not os.path.isfile(path):
        raise ApiError("PDFが見つかりません")
    at = d.get("at")
    start_at = (at + 1) if isinstance(at, int) and at >= 0 else len(doc)
    src = pymupdf.open(path)
    try:
        push_undo()
        doc.insert_pdf(src, start_at=start_at)
    finally:
        src.close()
    return status(inserted=True)


@api("/api/extract", methods=["POST"])
def extract_pages():
    """Save the selected pages to a new PDF at `path` (does not modify the doc)."""
    doc = require_doc()
    d = request.get_json(silent=True) or {}
    path = d.get("path")
    pages = sorted({p for p in (d.get("pages") or []) if 0 <= p < len(doc)})
    if not path:
        raise ApiError("保存先がありません")
    if not pages:
        raise ApiError("抽出するページがありません")
    out = pymupdf.open()
    try:
        for p in pages:
            out.insert_pdf(doc, from_page=p, to_page=p)
        out.save(path, garbage=4, deflate=True)
    finally:
        out.close()
    return jsonify(ok=True, count=len(pages))


# ── Search ──
@api("/api/search")
def search():
    doc = require_doc()
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify(results=[], count=0)
    results = []
    for i in range(len(doc)):
        for r in doc[i].search_for(q):
            results.append({"page": i, "rect": [r.x0, r.y0, r.x1, r.y1]})
    return jsonify(results=results, count=len(results))


# ── Form fields (widgets) ──
def _widget_dict(w):
    return {
        "name": w.field_name,
        "type": w.field_type_string,
        "value": w.field_value,
        "rect": [w.rect.x0, w.rect.y0, w.rect.x1, w.rect.y1],
        "options": list(w.choice_values) if w.choice_values else None,
    }


@api("/api/widgets/<int:idx>")
def get_widgets(idx):
    doc, page = require_page(idx)
    return jsonify(widgets=[_widget_dict(w) for w in page.widgets()])


@api("/api/widgets_count")
def widgets_count():
    doc = require_doc()
    total = sum(1 for _ in doc.widgets())
    return jsonify(count=total)


@api("/api/set_widget", methods=["POST"])
def set_widget():
    d = request.get_json(silent=True) or {}
    idx = d.get("page")
    name = d.get("name")
    if idx is None or name is None:
        raise ApiError("不正なリクエストです")
    doc, page = require_page(idx)
    push_undo()
    found = False
    for w in page.widgets():
        if w.field_name == name:
            w.field_value = d.get("value")
            w.update()
            found = True
            break
    if not found:
        state["undo_stack"].pop()  # nothing changed; drop the snapshot
        raise ApiError("フィールドが見つかりません", 404)
    return status()


# ── Undo / Redo ──
@api("/api/undo", methods=["POST"])
def undo():
    if not state["undo_stack"]:
        return status(ok=False)
    state["redo_stack"].append(state["doc"].tobytes())
    state["doc"] = pymupdf.open(stream=state["undo_stack"].pop(), filetype="pdf")
    state["dirty"] = True
    return status()


@api("/api/redo", methods=["POST"])
def redo():
    if not state["redo_stack"]:
        return status(ok=False)
    state["undo_stack"].append(state["doc"].tobytes())
    state["doc"] = pymupdf.open(stream=state["redo_stack"].pop(), filetype="pdf")
    state["dirty"] = True
    return status()


# ── Save ──
def _save_to(doc, path):
    try:
        doc.subset_fonts()  # shrink embedded fonts; best-effort
    except Exception:
        pass
    tmp = path + ".tmp_save"
    doc.save(tmp, garbage=4, deflate=True)
    os.replace(tmp, path)


@api("/api/save", methods=["POST"])
def save():
    """Save to disk. With `path` -> save-as; otherwise overwrite the open file."""
    doc = require_doc()
    d = request.get_json(silent=True) or {}
    path = d.get("path") or state["filepath_real"]
    if not path:
        raise ApiError("保存先がありません。「名前を付けて保存」を使ってください。")
    _save_to(doc, path)
    state["filepath_real"] = path
    state["filename"] = os.path.basename(path)
    state["dirty"] = False
    return status(saved=True)


@api("/api/download")
def download():
    """Browser-download fallback (used when no native dialog is available)."""
    doc = require_doc()
    buf = io.BytesIO(doc.tobytes(garbage=4, deflate=True))
    buf.seek(0)
    name = request.args.get("name") or state["filename"] or "edited.pdf"
    return send_file(buf, mimetype="application/pdf", as_attachment=True,
                     download_name=os.path.basename(name))


def start_server():
    app.run(port=8080, debug=False, use_reloader=False, threaded=True)


# ── Native window + file dialogs (pywebview js_api) ──
def _dialog_consts():
    import webview
    if hasattr(webview, "FileDialog"):  # newer pywebview (non-deprecated)
        return webview.FileDialog.OPEN, webview.FileDialog.SAVE
    return webview.OPEN_DIALOG, webview.SAVE_DIALOG


class NativeApi:
    """Exposed to JS as window.pywebview.api.* — provides native file dialogs."""

    def __init__(self):
        self.window = None

    def _ftypes(self):
        return ("PDF Files (*.pdf)", "All files (*.*)")

    def pick_open(self):
        open_const, _ = _dialog_consts()
        res = self.window.create_file_dialog(
            open_const, allow_multiple=False, file_types=self._ftypes())
        if not res:
            return None
        return res[0] if isinstance(res, (list, tuple)) else res

    def pick_pdf(self):
        return self.pick_open()

    def pick_save(self, default_name="edited.pdf"):
        _, save_const = _dialog_consts()
        res = self.window.create_file_dialog(
            save_const, save_filename=default_name, file_types=self._ftypes())
        if not res:
            return None
        return res[0] if isinstance(res, (list, tuple)) else res


if __name__ == "__main__":
    print("\n  PDF Editor starting...\n")
    if not JP_FONT_FILE:
        print("  [warn] 埋め込み用日本語フォントが見つかりませんでした（'japan' にフォールバック）")
    else:
        print(f"  [font] {JP_FONT_FILE}")

    t = threading.Thread(target=start_server, daemon=True)
    t.start()

    import webview
    native = NativeApi()
    window = webview.create_window(
        "PDF Editor",
        "http://localhost:8080",
        width=1360,
        height=860,
        min_size=(960, 640),
        js_api=native,
    )
    native.window = window
    webview.start()
