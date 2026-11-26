# Draws the plugin's fixed icons. Square shapes only. Run: python3 make-icons.py
from PIL import Image, ImageDraw
import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'com.rsvx.status.sdPlugin', 'imgs')
BG, PURPLE, GREEN, RED, WHITE, TRACK = (12, 12, 15, 255), (132, 87, 230, 255), (63, 185, 80, 255), (229, 72, 77, 255), (237, 237, 240, 255), (38, 38, 46, 255)

def save(name, size, paint, bg=None):
    for scale, suffix in ((1, ''), (2, '@2x')):
        s = size * scale
        im = Image.new('RGBA', (s, s), bg or (0, 0, 0, 0))
        paint(ImageDraw.Draw(im), s)
        im.save(os.path.join(OUT, name + suffix + '.png'))

def r(d, s, x0, y0, x1, y1, colour):  # rectangle given in fractions of the icon
    d.rectangle([round(x0 * s), round(y0 * s), round(x1 * s) - 1, round(y1 * s) - 1], fill=colour)

def bars(d, s, colours):  # three load bars
    for i, (w, c) in enumerate(colours):
        y = 0.2 + i * 0.24
        r(d, s, 0.15, y, 0.15 + 0.7 * w, y + 0.13, c)

def plugin(d, s):  # status stripe, a green square, and three bars
    r(d, s, 0, 0, 1, 0.09, PURPLE)
    r(d, s, 0.16, 0.24, 0.42, 0.50, GREEN)
    r(d, s, 0.50, 0.24, 0.84, 0.33, WHITE); r(d, s, 0.50, 0.41, 0.74, 0.50, TRACK)
    for i, w in enumerate((0.68, 0.42, 0.2)):
        y = 0.62 + i * 0.1
        r(d, s, 0.16, y, 0.84, y + 0.05, TRACK); r(d, s, 0.16, y, 0.16 + 0.68 * w, y + 0.05, PURPLE)

save('plugin', 256, plugin, BG)
save('category', 28, lambda d, s: (r(d, s, 0.14, 0.14, 0.5, 0.5, WHITE), r(d, s, 0.14, 0.62, 0.86, 0.72, WHITE), r(d, s, 0.14, 0.78, 0.6, 0.88, WHITE), r(d, s, 0.6, 0.14, 0.86, 0.5, WHITE)))
save('action-overall', 20, lambda d, s: r(d, s, 0.2, 0.2, 0.8, 0.8, WHITE))
save('action-load', 20, lambda d, s: bars(d, s, ((1.0, WHITE), (0.6, WHITE), (0.3, WHITE))))
save('action-service', 20, lambda d, s: (r(d, s, 0.15, 0.3, 0.45, 0.6, WHITE), r(d, s, 0.55, 0.3, 0.85, 0.42, WHITE), r(d, s, 0.55, 0.5, 0.75, 0.6, WHITE)))
save('action-failure', 20, lambda d, s: (r(d, s, 0.42, 0.15, 0.58, 0.6, WHITE), r(d, s, 0.42, 0.7, 0.58, 0.85, WHITE)))
save('key', 72, lambda d, s: (r(d, s, 0, 0, 1, 0.085, PURPLE), r(d, s, 0.36, 0.4, 0.64, 0.68, TRACK)), BG)
print(sorted(os.listdir(OUT)))
