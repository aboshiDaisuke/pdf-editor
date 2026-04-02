"""PDF Editor — Flask backend with PyMuPDF (standalone app)"""

from flask import Flask, request, jsonify, send_file
import pymupdf
import io
import os
import sys
import webbrowser
import threading

# Determine base path (works for both dev and PyInstaller bundle)
if getattr(sys, '_MEIPASS', None):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB

# ── State ──
state = {
    "doc": None,
    "filepath": None,
    "undo_stack": [],
    "redo_stack": [],
}

def push_undo():
    if not state["doc"]: return
    state["undo_stack"].append(state["doc"].tobytes())
    if len(state["undo_stack"]) > 30: state["undo_stack"].pop(0)
    state["redo_stack"].clear()

# ── Routes ──
@app.route("/")
def index():
    return send_file(os.path.join(BASE_DIR, "app.html"))

@app.route("/api/open", methods=["POST"])
def open_pdf():
    f = request.files.get("file")
    if not f: return jsonify(error="No file"), 400
    data = f.read()
    try:
        state["doc"] = pymupdf.open(stream=data, filetype="pdf")
        state["filepath"] = f.filename
        state["undo_stack"].clear()
        state["redo_stack"].clear()
        return jsonify(ok=True, pages=len(state["doc"]), filename=f.filename)
    except Exception as e:
        return jsonify(error=str(e)), 400

@app.route("/api/page/<int:idx>")
def get_page(idx):
    doc = state["doc"]
    if not doc or idx >= len(doc): return jsonify(error="No page"), 404
    zoom = float(request.args.get("zoom", 2))
    page = doc[idx]
    mat = pymupdf.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    buf = io.BytesIO(pix.tobytes("png"))
    buf.seek(0)
    return send_file(buf, mimetype="image/png")

@app.route("/api/page_count")
def page_count():
    doc = state["doc"]
    return jsonify(pages=len(doc) if doc else 0)

@app.route("/api/text/<int:idx>")
def get_text(idx):
    doc = state["doc"]
    if not doc or idx >= len(doc): return jsonify(error="No page"), 404
    page = doc[idx]
    blocks = page.get_text("dict")["blocks"]
    spans = []
    for b in blocks:
        if b.get("type") != 0: continue
        for ln in b.get("lines", []):
            for sp in ln.get("spans", []):
                t = sp.get("text", "").strip()
                if t:
                    c = sp.get("color", 0)
                    if isinstance(c, int):
                        hex_color = f"#{(c>>16)&0xFF:02x}{(c>>8)&0xFF:02x}{c&0xFF:02x}"
                    else:
                        hex_color = "#000000"
                    spans.append({
                        "text": sp["text"],
                        "size": round(sp["size"], 1),
                        "font": sp.get("font", ""),
                        "color": hex_color,
                        "bbox": list(sp["bbox"]),
                    })
    return jsonify(spans=spans)

@app.route("/api/edit_text", methods=["POST"])
def edit_text():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    d = request.json
    idx = d["page"]
    bbox = d["bbox"]
    new_text = d["new_text"]
    font_size = d.get("font_size", 12)
    color = d.get("color", [0, 0, 0])

    push_undo()
    page = doc[idx]
    rect = pymupdf.Rect(bbox)

    # Sample background color from the area
    clip = rect + (-2, -2, 2, 2)
    pix = page.get_pixmap(clip=clip, alpha=False)
    bg_r, bg_g, bg_b = pix.pixel(0, 0)
    bg_color = (bg_r / 255.0, bg_g / 255.0, bg_b / 255.0)

    # Erase original text with background color fill
    page.add_redact_annot(rect, fill=bg_color)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)

    # Insert new text at the original position
    text_color = tuple(color)
    x = rect.x0
    y = rect.y0 + font_size
    page.insert_text(pymupdf.Point(x, y), new_text,
                     fontsize=font_size, fontname="japan",
                     color=text_color)
    return jsonify(ok=True)

@app.route("/api/add_text", methods=["POST"])
def add_text():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    d = request.json
    push_undo()
    page = doc[d["page"]]
    page.insert_text(pymupdf.Point(d["x"], d["y"]), d["text"],
                     fontsize=d.get("size", 14), fontname="japan",
                     color=tuple(d.get("color", [0, 0, 0])))
    return jsonify(ok=True)

@app.route("/api/add_image", methods=["POST"])
def add_image():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    f = request.files.get("image")
    page_idx = int(request.form.get("page", 0))
    x = float(request.form.get("x", 50))
    y = float(request.form.get("y", 50))
    w = float(request.form.get("w", 200))

    push_undo()
    page = doc[page_idx]
    img_data = f.read()
    from PIL import Image
    img = Image.open(io.BytesIO(img_data))
    iw, ih = img.size
    h = w * ih / iw
    rect = pymupdf.Rect(x, y, x + w, y + h)
    page.insert_image(rect, stream=img_data)
    return jsonify(ok=True)

@app.route("/api/draw_shape", methods=["POST"])
def draw_shape():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    d = request.json
    push_undo()
    page = doc[d["page"]]
    color = tuple(d.get("color", [0, 0, 0]))
    width = d.get("width", 2)
    shape_type = d["type"]

    if shape_type == "rect":
        page.draw_rect(pymupdf.Rect(d["x0"], d["y0"], d["x1"], d["y1"]),
                       color=color, width=width)
    elif shape_type == "ellipse":
        page.draw_oval(pymupdf.Rect(d["x0"], d["y0"], d["x1"], d["y1"]),
                       color=color, width=width)
    elif shape_type == "line":
        page.draw_line(pymupdf.Point(d["x0"], d["y0"]),
                       pymupdf.Point(d["x1"], d["y1"]),
                       color=color, width=width)
    return jsonify(ok=True)

@app.route("/api/delete_page", methods=["POST"])
def delete_page():
    doc = state["doc"]
    if not doc or len(doc) <= 1: return jsonify(error="Cannot delete last page"), 400
    d = request.json
    push_undo()
    doc.delete_page(d["page"])
    return jsonify(ok=True, pages=len(doc))

@app.route("/api/delete_pages", methods=["POST"])
def delete_pages():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    d = request.json
    pages = sorted(d["pages"], reverse=True)  # delete from last to first
    if len(pages) >= len(doc): return jsonify(error="Cannot delete all pages"), 400
    push_undo()
    for p in pages:
        if 0 <= p < len(doc):
            doc.delete_page(p)
    return jsonify(ok=True, pages=len(doc))

@app.route("/api/add_page", methods=["POST"])
def add_page():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    push_undo()
    doc.new_page(pno=-1, width=595, height=842)
    return jsonify(ok=True, pages=len(doc))

@app.route("/api/move_page", methods=["POST"])
def move_page():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    d = request.json
    push_undo()
    doc.move_page(d["from"], d["to"])
    return jsonify(ok=True)

@app.route("/api/undo", methods=["POST"])
def undo():
    if not state["undo_stack"]: return jsonify(ok=False)
    state["redo_stack"].append(state["doc"].tobytes())
    state["doc"] = pymupdf.open(stream=state["undo_stack"].pop(), filetype="pdf")
    return jsonify(ok=True, pages=len(state["doc"]))

@app.route("/api/redo", methods=["POST"])
def redo():
    if not state["redo_stack"]: return jsonify(ok=False)
    state["undo_stack"].append(state["doc"].tobytes())
    state["doc"] = pymupdf.open(stream=state["redo_stack"].pop(), filetype="pdf")
    return jsonify(ok=True, pages=len(state["doc"]))

@app.route("/api/download")
def download():
    doc = state["doc"]
    if not doc: return jsonify(error="No doc"), 400
    buf = io.BytesIO(doc.tobytes())
    buf.seek(0)
    custom_name = request.args.get("name")
    if custom_name:
        name = custom_name
    else:
        name = state.get("filepath", "edited.pdf")
    return send_file(buf, mimetype="application/pdf", as_attachment=True,
                     download_name=os.path.basename(name))

def start_server():
    app.run(port=8080, debug=False, use_reloader=False)

if __name__ == "__main__":
    print("\n  PDF Editor starting...\n")
    # Start Flask in background thread
    t = threading.Thread(target=start_server, daemon=True)
    t.start()

    # Open native desktop window
    import webview
    webview.create_window(
        "PDF Editor",
        "http://localhost:8080",
        width=1280,
        height=820,
        min_size=(900, 600),
    )
    webview.start()
