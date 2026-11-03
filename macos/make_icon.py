#!/usr/bin/env python3
"""Draw the PCB Scope app icon (QFP chip under a lens) and write a macOS .iconset folder.
usage: make_icon.py <out.iconset>     then: iconutil -c icns <out.iconset> -o AppIcon.icns
Needs Pillow. The generated AppIcon.icns is committed, so a normal build does not need this.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

S = 2048  # draw large, downsample for anti-aliasing


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # macOS icon grid: 824/1024 squircle-ish rounded square with a soft shadow
    m = round(S * 100 / 1024)
    box = (m, m, S - m, S - m)
    rad = round(S * 185 / 1024)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((box[0], box[1] + 24, box[2], box[3] + 24), rad, fill=(0, 0, 0, 120))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)))
    # board: vertical gradient green
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp((22, 92, 60, 255), (8, 40, 27, 255), y / S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, rad, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # traces
    tc = (61, 220, 151, 70)
    w = 26
    for (pts) in [
        [(330, 1500), (560, 1500), (700, 1360)],
        [(330, 1640), (700, 1640), (860, 1480)],
        [(1720, 520), (1500, 520), (1380, 640)],
        [(1720, 380), (1380, 380), (1240, 520)],
    ]:
        d.line(pts, fill=tc, width=w, joint="curve")
        for p in (pts[0],):
            d.ellipse((p[0] - 34, p[1] - 34, p[0] + 34, p[1] + 34), outline=tc, width=16)
    # QFP chip
    cx, cy, half = 1000, 960, 330
    body = (cx - half, cy - half, cx + half, cy + half)
    pin_c = (214, 222, 205, 255)
    n, pw, pl = 7, 46, 150
    for i in range(n):
        o = -half + (i + 0.5) * (2 * half / n)
        for (x0, y0, x1, y1) in [
            (cx + o - pw / 2, cy - half - pl, cx + o + pw / 2, cy - half + 20),
            (cx + o - pw / 2, cy + half - 20, cx + o + pw / 2, cy + half + pl),
            (cx - half - pl, cy + o - pw / 2, cx - half + 20, cy + o + pw / 2),
            (cx + half - 20, cy + o - pw / 2, cx + half + pl, cy + o + pw / 2),
        ]:
            d.rounded_rectangle((x0, y0, x1, y1), 12, fill=pin_c)
    d.rounded_rectangle(body, 40, fill=(22, 26, 32, 255))
    d.rounded_rectangle((body[0] + 24, body[1] + 24, body[2] - 24, body[3] - 24), 28, outline=(45, 52, 62, 255), width=10)
    d.ellipse((body[0] + 70, body[1] + 70, body[0] + 140, body[1] + 140), fill=(48, 56, 66, 255))
    # detection box (dashed corners) in accent green
    acc = (61, 220, 151, 255)
    g = 70
    bx = (body[0] - 200, body[1] - 200, body[2] + 200, body[3] + 200)
    L = 170
    for (x, y, dx, dy) in [(bx[0], bx[1], 1, 1), (bx[2], bx[1], -1, 1), (bx[0], bx[3], 1, -1), (bx[2], bx[3], -1, -1)]:
        d.line([(x, y + dy * L), (x, y), (x + dx * L, y)], fill=acc, width=g // 2, joint="curve")
    # magnifier lens bottom-right
    lx, ly, lr = 1430, 1400, 260
    lens = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lens)
    ld.ellipse((lx - lr, ly - lr, lx + lr, ly + lr), fill=(180, 255, 220, 60))
    img.alpha_composite(lens)
    d.line([(lx + lr * 0.70, ly + lr * 0.70), (lx + lr * 1.55, ly + lr * 1.55)], fill=(230, 236, 240, 255), width=110)
    d.ellipse((lx - lr, ly - lr, lx + lr, ly + lr), outline=(236, 242, 246, 255), width=70)
    d.arc((lx - lr + 70, ly - lr + 70, lx + lr - 70, ly + lr - 70), 200, 260, fill=(255, 255, 255, 200), width=26)
    return img.resize((1024, 1024), Image.LANCZOS)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "AppIcon.iconset"
    os.makedirs(out, exist_ok=True)
    base = draw()
    for size in (16, 32, 128, 256, 512):
        base.resize((size, size), Image.LANCZOS).save(os.path.join(out, f"icon_{size}x{size}.png"))
        base.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(out, f"icon_{size}x{size}@2x.png"))


if __name__ == "__main__":
    main()
