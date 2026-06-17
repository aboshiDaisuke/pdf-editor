#!/usr/bin/env python3
"""Generate a professional macOS app icon for the PDF editor."""
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SS = 4
S = 1024 * SS


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def load_font(size):
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/System/Library/Fonts/SFNS.ttf",
              "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def build(mode):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # ── Tile: vertical red gradient clipped to a rounded rect ──
    margin, radius = 92 * SS, 200 * SS
    tile_box = (margin, margin, S - margin, S - margin)
    top, bot = (251, 96, 99), (193, 27, 46)
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(margin, S - margin):
        t = (y - margin) / (S - 2 * margin)
        gd.line([(0, y), (S, y)], fill=lerp(top, bot, t) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(tile_box, radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # top sheen
    sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse(
        (margin - 40 * SS, margin - 260 * SS, S - margin + 40 * SS, margin + 360 * SS),
        fill=(255, 255, 255, 46))
    sheen = sheen.filter(ImageFilter.GaussianBlur(60 * SS))
    img.paste(sheen, (0, 0),
              Image.composite(sheen.split()[3], Image.new("L", (S, S), 0), mask))
    hl = Image.new("L", (S, S), 0)
    ImageDraw.Draw(hl).rounded_rectangle((margin, margin, S - margin, margin + 8 * SS),
                                         radius=radius, fill=70)
    img.paste(Image.new("RGBA", (S, S), (255, 255, 255, 255)), (0, 0),
              Image.composite(hl, Image.new("L", (S, S), 0), mask))

    # ── Document with folded corner (+ shadow) ──
    px0, py0 = int(S * 0.305), int(S * 0.20)
    px1, py1 = int(S * 0.695), int(S * 0.815)
    fold = int(S * 0.115)
    pts = [(px0, py0), (px1 - fold, py0), (px1, py0 + fold), (px1, py1), (px0, py1)]
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + 6 * SS, y + 14 * SS) for x, y in pts],
                                   fill=(60, 6, 12, 130))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22 * SS)))
    d = ImageDraw.Draw(img)
    d.polygon(pts, fill=(255, 255, 255, 255))
    d.polygon([(px1 - fold, py0), (px1, py0 + fold), (px1 - fold, py0 + fold)],
              fill=(214, 220, 228, 255))
    d.line([(px1 - fold, py0), (px1 - fold, py0 + fold), (px1, py0 + fold)],
           fill=(188, 196, 206, 255), width=3 * SS)

    # ── Text lines ──
    lx0, lx1 = px0 + int(S * 0.045), px1 - int(S * 0.045)
    ly, gap, bar_h = py0 + int(S * 0.12), int(S * 0.052), int(S * 0.022)
    for i, w in enumerate([1.0, 1.0, 0.7]):
        y = ly + i * gap
        d.rounded_rectangle((lx0, y, lx0 + int((lx1 - lx0) * w), y + bar_h),
                            radius=bar_h // 2, fill=(206, 212, 221, 255))

    # ── PDF wordmark (centered, clear of the pencil) ──
    if mode in ("text", "both"):
        font = load_font(int(S * 0.10))
        bb = d.textbbox((0, 0), "PDF", font=font)
        tw = bb[2] - bb[0]
        tx = (px0 + px1) // 2 - tw // 2 - bb[0]
        ty = int(S * 0.50) - bb[1]
        d.text((tx, ty), "PDF", font=font, fill=(196, 30, 48, 255))

    # ── Pencil ──
    if mode in ("pencil", "both"):
        PL, PH = int(S * 0.46), int(S * 0.095)
        pen = Image.new("RGBA", (PL, PH), (0, 0, 0, 0))
        pd = ImageDraw.Draw(pen)
        bl, br = int(PL * 0.16), int(PL * 0.80)
        pd.rectangle((bl, 0, br, PH), fill=(245, 181, 60, 255))
        pd.rectangle((bl, 0, br, int(PH * 0.30)), fill=(252, 201, 99, 255))
        pd.rectangle((bl, int(PH * 0.74), br, PH), fill=(214, 150, 38, 255))
        pd.rounded_rectangle((0, 0, int(PL * 0.085), PH), radius=PH // 2,
                             fill=(238, 122, 128, 255))
        pd.rectangle((int(PL * 0.085), 0, bl, PH), fill=(210, 214, 220, 255))
        pd.polygon([(br, 0), (br, PH), (int(PL * 0.965), PH // 2)], fill=(232, 198, 150, 255))
        pd.polygon([(int(PL * 0.92), int(PH * 0.30)), (int(PL * 0.92), int(PH * 0.70)),
                    (int(PL * 0.965), PH // 2)], fill=(54, 56, 66, 255))
        pen = pen.rotate(-38, expand=True, resample=Image.BICUBIC)
        # bottom-right placement so it doesn't cover the wordmark
        ox = int(S * 0.45) if mode == "both" else int(S * 0.40)
        oy = int(S * 0.585) if mode == "both" else int(S * 0.50)
        psh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        psh.paste(pen, (ox + 5 * SS, oy + 9 * SS), pen)
        img.alpha_composite(psh.filter(ImageFilter.GaussianBlur(10 * SS)))
        img.paste(pen, (ox, oy), pen)

    return img.resize((1024, 1024), Image.LANCZOS)


mode = sys.argv[1] if len(sys.argv) > 1 else "both"
build(mode).save(f"/tmp/icon_{mode}.png")
print(f"wrote /tmp/icon_{mode}.png")
