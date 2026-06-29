"""
순수 표준 라이브러리(zlib, struct)만으로 확장 아이콘 PNG를 생성한다.
외부 의존성(PIL 등) 없이 동작하므로 어떤 환경에서도 재실행 가능.

생성물: icons/icon16.png, icon48.png, icon128.png
디자인: 인디고 배경 + 흰색 텍스트 라인 3개(텍스트) + 청록 강조 막대(추출/선택).

사용:  python tools/make_icons.py
"""
import os
import zlib
import struct

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

BG = (79, 70, 229, 255)        # indigo-600
LINE = (255, 255, 255, 255)    # white text lines
ACCENT = (45, 212, 191, 255)   # teal-400 selection/extract marker


def write_png(path, w, h, px):
    """px: list of (r,g,b,a) length w*h, row-major."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0 (None)
        for x in range(w):
            raw.extend(px[y * w + x])

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def rounded(x, y, w, h, r):
    """둥근 모서리 안쪽인지 판정."""
    if x < r and y < r:
        return (r - x) ** 2 + (r - y) ** 2 <= r * r
    if x >= w - r and y < r:
        return (x - (w - r - 1)) ** 2 + (r - y) ** 2 <= r * r
    if x < r and y >= h - r:
        return (r - x) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    if x >= w - r and y >= h - r:
        return (x - (w - r - 1)) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    return True


def make(size):
    s = size
    px = [(0, 0, 0, 0)] * (s * s)
    r = max(2, s // 6)

    # 배경 (둥근 사각형)
    for y in range(s):
        for x in range(s):
            if rounded(x, y, s, s, r):
                px[y * s + x] = BG

    def fill_rect(x0, y0, x1, y1, color):
        for y in range(max(0, y0), min(s, y1)):
            for x in range(max(0, x0), min(s, x1)):
                if rounded(x, y, s, s, r):
                    px[y * s + x] = color

    unit = s / 16.0
    bar_h = max(1, round(unit * 1.6))
    gap = max(1, round(unit * 1.6))
    left = round(unit * 3.5)
    top = round(unit * 3.2)

    widths = [round(unit * 9), round(unit * 7), round(unit * 8)]
    y = top
    for i, w in enumerate(widths):
        fill_rect(left, y, left + w, y + bar_h, LINE)
        y += bar_h + gap

    # 청록 강조 막대(선택/추출 표시) — 왼쪽 세로 바
    fill_rect(round(unit * 2.0), top, round(unit * 2.0) + max(1, round(unit * 0.9)),
              y - gap, ACCENT)

    return px


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        write_png(os.path.join(OUT_DIR, f"icon{size}.png"), size, size, make(size))
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
