from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
PET_DIR = ROOT / "assets" / "pets" / "hammer-dude"
TRAY_DIR = ROOT / "assets" / "tray"

CELL_W = 192
CELL_H = 208
COLS = 8
ROWS = 9

STATE_COLORS = [
    (63, 131, 248, 255),
    (34, 197, 94, 255),
    (20, 184, 166, 255),
    (245, 158, 11, 255),
    (236, 72, 153, 255),
    (239, 68, 68, 255),
    (168, 85, 247, 255),
    (14, 165, 233, 255),
    (100, 116, 139, 255),
]


def font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/msyh.ttc",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    return ImageFont.load_default()


def draw_pet_cell(draw: ImageDraw.ImageDraw, row: int, col: int) -> None:
    base = STATE_COLORS[row]
    cx = col * CELL_W + CELL_W // 2
    cy = row * CELL_H + CELL_H // 2 + 4
    bounce = [0, -2, -5, -2, 0, 2, 4, 2][col % 8]
    lean = (col % 4 - 1.5) * 2

    shadow = [cx - 46, cy + 66, cx + 46, cy + 78]
    draw.ellipse(shadow, fill=(15, 23, 42, 54))

    body = [cx - 42 + lean, cy - 26 + bounce, cx + 42 + lean, cy + 62 + bounce]
    head = [cx - 36 + lean, cy - 82 + bounce, cx + 36 + lean, cy - 10 + bounce]
    draw.rounded_rectangle(body, radius=22, fill=base, outline=(255, 255, 255, 190), width=3)
    draw.ellipse(head, fill=(255, 224, 178, 255), outline=(71, 85, 105, 210), width=3)

    eye_y = cy - 50 + bounce
    draw.ellipse([cx - 17 + lean, eye_y - 4, cx - 9 + lean, eye_y + 4], fill=(15, 23, 42, 255))
    draw.ellipse([cx + 9 + lean, eye_y - 4, cx + 17 + lean, eye_y + 4], fill=(15, 23, 42, 255))
    draw.arc([cx - 15 + lean, cy - 45 + bounce, cx + 15 + lean, cy - 24 + bounce], 10, 170, fill=(15, 23, 42, 255), width=2)

    arm_wave = -24 if row == 3 else 0
    left_arm = [cx - 58 + lean, cy - 10 + bounce, cx - 30 + lean, cy + 34 + bounce]
    right_arm = [cx + 30 + lean, cy - 10 + bounce + arm_wave, cx + 58 + lean, cy + 34 + bounce]
    draw.line(left_arm, fill=(255, 224, 178, 255), width=11)
    draw.line(right_arm, fill=(255, 224, 178, 255), width=11)

    hammer_x = cx + 62 + lean
    hammer_y = cy - 16 + bounce + arm_wave
    draw.line([cx + 40 + lean, cy + 8 + bounce + arm_wave, hammer_x, hammer_y], fill=(120, 113, 108, 255), width=6)
    draw.rounded_rectangle(
        [hammer_x - 17, hammer_y - 20, hammer_x + 17, hammer_y - 2],
        radius=4,
        fill=(148, 163, 184, 255),
        outline=(51, 65, 85, 255),
        width=2,
    )

    if row in (1, 2, 7):
        step = -8 if col % 2 else 8
        draw.line([cx - 18, cy + 60 + bounce, cx - 40, cy + 82 + step], fill=(30, 41, 59, 255), width=8)
        draw.line([cx + 18, cy + 60 + bounce, cx + 40, cy + 82 - step], fill=(30, 41, 59, 255), width=8)
    elif row == 4:
        draw.line([cx - 18, cy + 58 + bounce, cx - 34, cy + 74 + bounce], fill=(30, 41, 59, 255), width=8)
        draw.line([cx + 18, cy + 58 + bounce, cx + 34, cy + 74 + bounce], fill=(30, 41, 59, 255), width=8)
    else:
        draw.line([cx - 18, cy + 58 + bounce, cx - 28, cy + 82 + bounce], fill=(30, 41, 59, 255), width=8)
        draw.line([cx + 18, cy + 58 + bounce, cx + 28, cy + 82 + bounce], fill=(30, 41, 59, 255), width=8)

    small_font = font(14)
    draw.text((col * CELL_W + 8, row * CELL_H + 8), f"{row}:{col}", fill=(255, 255, 255, 210), font=small_font)


def make_spritesheet() -> None:
    PET_DIR.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (CELL_W * COLS, CELL_H * ROWS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for row in range(ROWS):
        for col in range(COLS):
            draw_pet_cell(draw, row, col)
    image.save(PET_DIR / "spritesheet.webp", "WEBP", lossless=True, quality=100)


def make_tray_icon() -> None:
    TRAY_DIR.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse([6, 6, 58, 58], fill=(63, 131, 248, 255))
    draw.rounded_rectangle([16, 30, 48, 42], radius=5, fill=(226, 232, 240, 255))
    draw.line([21, 43, 12, 55], fill=(120, 113, 108, 255), width=6)
    draw.ellipse([24, 16, 40, 32], fill=(255, 224, 178, 255))
    image.save(TRAY_DIR / "icon.png")


if __name__ == "__main__":
    make_spritesheet()
    make_tray_icon()
