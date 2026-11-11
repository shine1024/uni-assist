"""확장 아이콘 생성: python tools/make-icons.py  →  icons/icon{16,32,48,128}.png

사이드 패널 로고(icons.js 의 logo)와 같은 모양: 차콜 둥근 사각형 + 흰 U + 페리윙클 바.
작은 크기는 선을 굵게 하고 발광을 뺀다. 4배로 그린 뒤 줄여서 가장자리를 매끄럽게 한다.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "icons"
SS = 4  # 슈퍼샘플링 배율

BG_TOP = (44, 47, 56)
BG_BOTTOM = (22, 23, 27)
EDGE = (255, 255, 255, 40)
INK = (240, 242, 246, 255)
ACCENT = (136, 166, 255, 255)  # xAI accent-blue (사이드 패널 --accent)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw_icon(size):
    s = size * SS
    small = size <= 32
    pad = 0 if small else round(s * 0.04)
    radius = round(s * (0.26 if small else 0.24))

    # 세로 그라데이션 바탕
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        gd.line([(0, y), (s, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / (s - 1)) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, s - 1 - pad, s - 1 - pad], radius, fill=255)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    if not small:
        d.rounded_rectangle([pad, pad, s - 1 - pad, s - 1 - pad], radius, outline=EDGE, width=max(SS, s // 64))

    # U 마크
    stroke = round(s * (0.13 if small else 0.085))
    left, right = s * 0.31, s * 0.69
    top, bottom = s * (0.22 if small else 0.25), s * (0.62 if small else 0.60)
    r = (right - left) / 2
    cy = bottom - r
    d.line([(left, top), (left, cy)], fill=INK, width=stroke)
    d.line([(right, top), (right, cy)], fill=INK, width=stroke)
    h = stroke / 2  # arc 의 선은 테두리 안쪽으로 그려지므로 반 굵기만큼 바깥으로 키운다
    d.arc([left - h, cy - r - h, right + h, cy + r + h], 0, 180, fill=INK, width=stroke)
    for x in (left, right):  # 둥근 끝
        d.ellipse([x - stroke / 2, top - stroke / 2, x + stroke / 2, top + stroke / 2], fill=INK)

    # 페리윙클 바 (+ 큰 크기에서만 발광)
    bar_y = s * (0.80 if small else 0.76)
    bar_h = round(s * (0.11 if small else 0.06))
    bar = [s * 0.31, bar_y - bar_h / 2, s * 0.69, bar_y + bar_h / 2]
    if not small:
        glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        ImageDraw.Draw(glow).rounded_rectangle(bar, bar_h, fill=ACCENT[:3] + (170,))
        glow = glow.filter(ImageFilter.GaussianBlur(s * 0.035))
        clipped = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        clipped.paste(glow, (0, 0), mask)
        img = Image.alpha_composite(img, clipped)
        d = ImageDraw.Draw(img)
    d.rounded_rectangle(bar, bar_h, fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for size in (16, 32, 48, 128):
        draw_icon(size).save(OUT / f"icon{size}.png")
        print(f"icons/icon{size}.png")
