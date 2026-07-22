"""Generate DayLog PNG icons (matches icon.svg). Run: python generate_icons.py
Requires Pillow. Produces icon-192, icon-512, apple-touch-icon (180)."""
from PIL import Image, ImageDraw


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def diagonal_gradient(size, c0, c1):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(c0, c1, t)
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def render(size):
    s = size / 512.0
    def S(v):
        return round(v * s)

    grad = diagonal_gradient(size, (0x44, 0x38, 0xCA), (0x25, 0x63, 0xEB))
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), rounded_mask(size, S(112)))

    d = ImageDraw.Draw(icon)
    white = (255, 255, 255, 255)
    teal = (0x0F, 0x76, 0x6E, 255)
    lav = (0xC7, 0xC4, 0xF0, 255)
    ink = (0x44, 0x38, 0xCA, 255)
    faint = (0xCB, 0xD2, 0xE8, 255)

    # binding posts
    d.rounded_rectangle([S(180), S(112), S(196), S(152)], radius=S(8), fill=lav)
    d.rounded_rectangle([S(316), S(112), S(332), S(152)], radius=S(8), fill=lav)

    # notepad body
    d.rounded_rectangle([S(120), S(128), S(392), S(416)], radius=S(34), fill=white)
    # teal header band
    header = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(header)
    hd.rounded_rectangle([S(120), S(128), S(392), S(200)], radius=S(34), fill=teal)
    hd.rectangle([S(120), S(176), S(392), S(200)], fill=teal)
    icon.alpha_composite(header)
    d = ImageDraw.Draw(icon)

    # binding rings
    d.ellipse([S(172), S(104), S(204), S(136)], fill=white)
    d.ellipse([S(308), S(104), S(340), S(136)], fill=white)

    # text lines
    d.rounded_rectangle([S(156), S(242), S(276), S(262)], radius=S(10), fill=ink)
    for y in (286, 324):
        d.rounded_rectangle([S(156), S(y), S(356), S(y + 18)], radius=S(9), fill=faint)
    d.rounded_rectangle([S(156), S(362), S(296), S(380)], radius=S(9), fill=faint)

    return icon


for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
    render(size).save(name)
    print("wrote", name)
