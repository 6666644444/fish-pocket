#!/usr/bin/env python3
"""Build the app icon, its recoloured alternates, the launch mark and README mascot from mascot-icon.png.

Run from the repository root: docs/design/brand/make-icons.py
The alternate icons without the mascot are drawn by make-drawn-icons.swift; run that first.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageOps

CATALOG = "app/DshIOS/Assets.xcassets/"


def rounded(image, size):
    """The drawing on a transparent canvas with the icon's corners, for use outside the app icon."""
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), size, fill=255)
    result = image.resize((size, size), Image.LANCZOS).convert("RGBA")
    result.putalpha(mask.resize((size, size), Image.LANCZOS))
    return result


icon = Image.open("docs/design/brand/mascot-icon.png").convert("RGB").resize((1024, 1024), Image.LANCZOS)
icons = CATALOG + "AppIcon.appiconset/"
icon.save(icons + "AppIcon.png", optimize=True)
icon.save(icons + "AppIcon-Dark.png", optimize=True)
ImageOps.grayscale(icon).save(icons + "AppIcon-Tinted.png", optimize=True)
icon.resize((192, 192), Image.LANCZOS).save("docs/assets/icon.png", optimize=True)
rounded(icon, 640).save("docs/assets/mascot.png", optimize=True)


def recolored(image, hue, saturation=1.0):
    """The blues (hair, eyes, bows, background) turned to another hue; skin and whites stay.

    The shift fades out towards the edges of the blue band, so the colours meet without seams.
    """
    hsv = np.asarray(image.convert("HSV")).astype(np.float32)
    h, s, v = hsv[..., 0] * 360 / 255, hsv[..., 1], hsv[..., 2]
    distance = np.abs((h - 225 + 180) % 360 - 180)
    weight = np.clip((70 - distance) / 25, 0, 1)
    h = (h + (hue - 225) * weight) % 360
    s = np.clip(s * (1 + (saturation - 1) * weight), 0, 255)
    pixels = np.stack([h * 255 / 360, s, v], -1).round().astype(np.uint8)
    return Image.fromarray(pixels, "HSV").convert("RGB")


def preview(image, name):
    """The picture the icon page shows (app icon sets cannot be loaded as images): 60 pt at 3x."""
    image.resize((180, 180), Image.LANCZOS).save(CATALOG + f"AppIconPreview/{name}.imageset/{name}.png", optimize=True)


preview(icon, "Default")

# The alternate icons people can pick in Settings (app/DshIOS/Views/AppIconPage.swift).
for name, hue, saturation in [("Pink", 335, 0.9), ("Mint", 165, 0.85), ("Violet", 275, 1.0)]:
    folder = CATALOG + f"AppIcon-{name}.appiconset/"
    variant = recolored(icon, hue, saturation)
    variant.save(folder + "AppIcon.png", optimize=True)
    variant.save(folder + "AppIcon-Dark.png", optimize=True)
    ImageOps.grayscale(variant).save(folder + "AppIcon-Tinted.png", optimize=True)
    preview(variant, name)

# Drawn by make-drawn-icons.swift and make-wordmark-icons.swift, run first.
for name in ["Whale", "WordPixel", "WordPoster", "WordMono"]:
    preview(Image.open(CATALOG + f"AppIcon-{name}.appiconset/AppIcon.png").convert("RGB"), name)

# Made with an image model (Codex image generation) and kept as they came in generated/:
# a geometric whale, a pixel-art whale, and a sticker of the mascot.
for name, source in [("Geometric", "geometric"), ("Pixel", "pixel"), ("Sticker", "sticker")]:
    folder = CATALOG + f"AppIcon-{name}.appiconset/"
    picture = Image.open(f"docs/design/brand/generated/{source}.png").convert("RGB").resize((1024, 1024), Image.LANCZOS)
    picture.save(folder + "AppIcon.png", optimize=True)
    picture.save(folder + "AppIcon-Dark.png", optimize=True)
    ImageOps.grayscale(picture).save(folder + "AppIcon-Tinted.png", optimize=True)
    preview(picture, name)

for scale, suffix in [(2, "@2x"), (3, "@3x")]:
    mark = rounded(icon, 72 * scale)
    mark.save(CATALOG + f"LaunchMark.imageset/LaunchMark{suffix}.png", optimize=True)
    mark.save(CATALOG + f"LaunchMark.imageset/LaunchMark-Dark{suffix}.png", optimize=True)
