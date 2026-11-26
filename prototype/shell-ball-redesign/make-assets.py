#!/usr/bin/env python3
"""把录制帧拼成四联对比图与 GIF 逐帧素材。只依赖 Pillow。"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SHOTS = ROOT / "shots"
FRAMES = SHOTS / "frames"
FRAMES_IDLE = SHOTS / "frames-idle"
ALL = FRAMES / "all"

VARIANTS = [
    ("aurora", "A", "极光玻璃", "AURORA GLASS"),
    ("pulse", "B", "脉冲核心", "PULSE CORE"),
    ("orbit", "C", "轨道信标", "ORBIT BEACON"),
    ("prism", "D", "液态棱镜", "LIQUID PRISM"),
]

FONT_CN = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_MONO = "/System/Library/Fonts/Menlo.ttc"
TILE = 248
GAP = 18
MARGIN = 28
WIDTH = MARGIN * 2 + TILE * 4 + GAP * 3
HEIGHT = 344
TILE_Y = 44


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, index=index)


def backdrop() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "#080b11")
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        blend = max(0.0, 1.0 - y / 260)
        r = int(8 + 14 * blend)
        g = int(11 + 18 * blend)
        b = int(17 + 38 * blend)
        draw.line((0, y, WIDTH, y), fill=(r, g, b))
    return image


def tile_image(source: Image.Image, size: int) -> Image.Image:
    """裁掉舞台边缘的暗角，只留下球体周围的壁纸。"""
    inset = 24
    cropped = source.convert("RGB").crop((inset, inset, source.width - inset, source.height - inset))
    return cropped.resize((size, size), Image.LANCZOS)


def compose(frames_dir: Path, frame: str, out_path: Path, state_label: str) -> None:
    canvas = backdrop()
    draw = ImageDraw.Draw(canvas)
    name_font = font(FONT_CN, 13)
    mono = font(FONT_MONO, 8)

    draw.text((MARGIN, 20), state_label, font=font(FONT_CN, 9), fill=(91, 147, 255))
    label = "2.4× · 56 px 窗口"
    top_font = font(FONT_CN, 9)
    bbox = draw.textbbox((0, 0), label, font=top_font)
    draw.text((WIDTH - MARGIN - (bbox[2] - bbox[0]), 20), label, font=top_font, fill=(90, 99, 118))

    for index, (key, letter, name, english) in enumerate(VARIANTS):
        path = frames_dir / key / f"{frame}.png"
        source = Image.open(path)
        x = MARGIN + index * (TILE + GAP)
        canvas.paste(tile_image(source, TILE), (x, TILE_Y))
        draw.rectangle((x, TILE_Y, x + TILE - 1, TILE_Y + TILE - 1), outline=(36, 45, 64), width=1)
        draw.text((x, TILE_Y + TILE + 12), f"{letter}", font=font(FONT_MONO, 10), fill=(91, 147, 255))
        draw.text((x + 18, TILE_Y + TILE + 9), name, font=name_font, fill=(233, 237, 245))
        draw.text((x, TILE_Y + TILE + 27), english, font=mono, fill=(90, 99, 118))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    print(f"wrote {out_path.relative_to(ROOT)}")


def compose_all_frames() -> None:
    ALL.mkdir(parents=True, exist_ok=True)
    count = len(list((FRAMES / "aurora").glob("*.png")))
    top_font = font(FONT_CN, 9)
    name_font = font(FONT_CN, 13)
    mono = font(FONT_MONO, 8)
    for i in range(count):
        frame = f"{i:03d}"
        canvas = backdrop()
        draw = ImageDraw.Draw(canvas)
        draw.text((MARGIN, 20), "BUSY · 思考态", font=top_font, fill=(91, 147, 255))
        label = "2.4× · 56 px 窗口"
        bbox = draw.textbbox((0, 0), label, font=top_font)
        draw.text((WIDTH - MARGIN - (bbox[2] - bbox[0]), 20), label, font=top_font, fill=(90, 99, 118))
        for index, (key, letter, name, english) in enumerate(VARIANTS):
            source = Image.open(FRAMES / key / f"{frame}.png")
            x = MARGIN + index * (TILE + GAP)
            canvas.paste(tile_image(source, TILE), (x, TILE_Y))
            draw.rectangle((x, TILE_Y, x + TILE - 1, TILE_Y + TILE - 1), outline=(36, 45, 64), width=1)
            draw.text((x, TILE_Y + TILE + 12), f"{letter}", font=font(FONT_MONO, 10), fill=(91, 147, 255))
            draw.text((x + 18, TILE_Y + TILE + 9), name, font=name_font, fill=(233, 237, 245))
            draw.text((x, TILE_Y + TILE + 27), english, font=mono, fill=(90, 99, 118))
        canvas.save(ALL / f"{frame}.png")
    print(f"wrote {count} composite frames")


compose(FRAMES_IDLE, "000", SHOTS / "contact-idle.png", "IDLE · 待机")
compose(FRAMES, "008", SHOTS / "contact-busy.png", "BUSY · 思考态")
compose_all_frames()
