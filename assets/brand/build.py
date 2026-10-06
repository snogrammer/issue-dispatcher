"""Build every IssueDispatcher brand asset from one mark definition.

The mark (hex badge, terminal prompt, motion lines, Git badge) lives in
src/mark.svg.part in a 512x512 coordinate space. This script places it into
each logo, banner and icon SVG, then renders the PNG and ICO exports, so a
change to the mark is one edit plus a rerun.

Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick), and the
Inter font installed for the raster text; the SVGs fall back to system fonts.

Usage: python3 assets/brand/build.py
"""

import re
import subprocess
from pathlib import Path

out = Path(__file__).resolve().parent
FRAG = (out / "src" / "mark.svg.part").read_text()
NAVY, NAVY2, BLUE, MUTED, LIGHT = "#0B1726", "#14263B", "#2678FF", "#708096", "#F5F8FC"
FONT = "Inter, 'Helvetica Neue', Arial, sans-serif"
TAGLINE = "Turn Gitea issues into autonomous Claude Code work."
KICKER = "GITEA  ·  CLAUDE CODE  ·  HEADLESS AUTOMATION"


def mark(git=True, uid=""):
    f = FRAG
    if not git:
        f = f[: f.index("<!-- git branch badge -->")]
    # Unique gradient ids so several marks can share one document.
    return f.replace('id="flow"', f'id="flow{uid}"').replace("url(#flow)", f"url(#flow{uid})")


def svg(w, h, body):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" role="img" aria-label="IssueDispatcher">\n{body}\n</svg>\n'
    )


def name(x, y, size, ink, anchor="start"):
    return (
        f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{FONT}" font-size="{size}" '
        f'font-weight="800" letter-spacing="{-size * 0.02:.1f}" fill="{ink}">Issue'
        f'<tspan fill="{BLUE}">Dispatcher</tspan></text>'
    )


def small(x, y, size, ink, text, anchor="start", weight=600, spacing=None):
    sp = f' letter-spacing="{spacing}"' if spacing is not None else ""
    return (
        f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{FONT}" font-size="{size}" '
        f'font-weight="{weight}"{sp} fill="{ink}">{text}</text>'
    )


def placed(x, y, scale, git=True, uid=""):
    return f'<g transform="translate({x} {y}) scale({scale})">\n{mark(git, uid)}</g>'


def background(w, h, dark, glow_x, glow_y, glow_r):
    a, b = (NAVY, NAVY2) if dark else (LIGHT, "#E6EEF9")
    glow = "#1D4E9E" if dark else "#BFD4F5"
    return (
        "<defs>"
        f'<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{a}"/>'
        f'<stop offset="1" stop-color="{b}"/></linearGradient>'
        f'<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="{glow_x}" cy="{glow_y}" r="{glow_r}">'
        f'<stop offset="0" stop-color="{glow}" stop-opacity=".55"/>'
        f'<stop offset="1" stop-color="{glow}" stop-opacity="0"/></radialGradient>'
        "</defs>"
        f'<rect width="{w}" height="{h}" fill="url(#bg)"/>'
        f'<rect width="{w}" height="{h}" fill="url(#glow)"/>'
    )


def banner(w, h, dark, title_size, sub, sub_size, mark_scale, mark_x, mark_y, text_x, title_y):
    ink = "#FFFFFF" if dark else NAVY
    sub_ink = "#A9B6C7" if dark else MUTED
    cx, cy = mark_x + 256 * mark_scale, mark_y + 256 * mark_scale
    return svg(
        w,
        h,
        background(w, h, dark, cx, cy, 300 * mark_scale * 1.6)
        + placed(mark_x, mark_y, mark_scale)
        + name(text_x, title_y, title_size, ink)
        + small(text_x, title_y + sub_size * 1.9, sub_size, sub_ink, sub, weight=500)
        + small(text_x, h - h * 0.11, round(sub_size * 0.62), MUTED, KICKER, spacing=2),
    )


files = {
    "svg/issuedispatcher-icon.svg": svg(512, 512, mark()),
    "svg/issuedispatcher-icon-no-git.svg": svg(512, 512, mark(git=False)),
}
for variant, ink, sub_ink in (("dark", NAVY, MUTED), ("light", "#FFFFFF", "#A9B6C7")):
    files[f"svg/issuedispatcher-wordmark-{variant}.svg"] = svg(
        1500,
        430,
        placed(10, 15, 0.78)
        + name(450, 210, 112, ink)
        + small(456, 272, 27, sub_ink, "GITEA  +  CLAUDE CODE  +  AUTOMATION", spacing=6),
    )
    files[f"svg/issuedispatcher-stacked-{variant}.svg"] = svg(
        900,
        720,
        placed(170, 10, 1.1)
        + name(450, 580, 92, ink, anchor="middle")
        + small(450, 645, 24, sub_ink, "GITEA  +  CLAUDE CODE  +  AUTOMATION", anchor="middle", spacing=5),
    )

# Banners: the mark sits left of the text, so nothing overlaps the name.
files["web/issuedispatcher-header-dark.svg"] = banner(1600, 420, True, 104, TAGLINE, 30, 0.62, 90, 50, 470, 205)
files["web/issuedispatcher-header-light.svg"] = banner(1600, 420, False, 104, TAGLINE, 30, 0.62, 90, 50, 470, 205)
files["web/issuedispatcher-hero-dark.svg"] = banner(
    2400, 900, True, 150, "Assign an issue. Dispatch the bot. Let Claude Code ship the work.", 42, 1.15, 120, 140, 790, 430
)
files["social/og-image.svg"] = banner(1200, 630, True, 92, "Gitea issues → Claude Code → merged PRs", 30, 0.62, 60, 150, 400, 300)

# Favicon: the hex alone, cropped square; the motion lines and badge turn to
# mush at 16-48px.
hex_only = FRAG[: FRAG.index("<!-- git branch badge -->")]
hex_only = re.sub(r"<!-- motion lines -->\n<path[^>]*/>\n", "", hex_only)
files["favicon/favicon.svg"] = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="98 52 352 352">\n'
    f"{hex_only}</svg>\n"
)
files["web/brand-variables.css"] = """:root {
  --id-navy: #0b1726;
  --id-navy-2: #14263b;
  --id-blue: #2678ff;
  --id-purple: #6a2bff;
  --id-cyan: #13bfe8;
  --id-green: #45a52f;
  --id-orange: #ff5a36;
  --id-muted: #708096;
  --id-light: #f5f8fc;
}
"""

for rel, content in files.items():
    p = out / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(re.sub(r"\n\s*\n", "\n", content))
    print(rel)


def render(src, dst, width, background=None):
    cmd = ["rsvg-convert", "-w", str(width), str(out / src), "-o", str(out / dst)]
    if background:
        cmd[1:1] = ["-b", background]
    (out / dst).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(cmd, check=True)
    print(dst)


for size in (64, 128, 256, 512):
    render("svg/issuedispatcher-icon.svg", f"png/issuedispatcher-icon-{size}.png", size)
render("svg/issuedispatcher-icon-no-git.svg", "png/issuedispatcher-icon-no-git-512.png", 512)
for variant in ("dark", "light"):
    render(f"svg/issuedispatcher-wordmark-{variant}.svg", f"png/issuedispatcher-wordmark-{variant}.png", 1500)
    render(f"svg/issuedispatcher-stacked-{variant}.svg", f"png/issuedispatcher-stacked-{variant}.png", 900)
for banner_name in ("header-dark", "header-light", "hero-dark"):
    svg_path = out / "web" / f"issuedispatcher-{banner_name}.svg"
    width = int(re.search(r'width="(\d+)"', svg_path.read_text()).group(1))
    render(f"web/issuedispatcher-{banner_name}.svg", f"web/issuedispatcher-{banner_name}.png", width)
render("social/og-image.svg", "social/og-image.png", 1200)
for size in (16, 32, 48):
    render("favicon/favicon.svg", f"favicon/favicon-{size}.png", size)
render("favicon/favicon.svg", "favicon/android-chrome-192.png", 192)
render("favicon/favicon.svg", "favicon/android-chrome-512.png", 512)
# iOS fills transparency with black and rounds the corners, so the touch icon
# is the hex on brand navy with room around it.
render("favicon/favicon.svg", "favicon/apple-touch-icon.png", 136)
subprocess.run(
    ["magick", str(out / "favicon/apple-touch-icon.png"), "-background", NAVY, "-gravity", "center",
     "-extent", "180x180", "-flatten", str(out / "favicon/apple-touch-icon.png")],
    check=True,
)
subprocess.run(
    ["magick", *(str(out / f"favicon/favicon-{s}.png") for s in (16, 32, 48)), str(out / "favicon/favicon.ico")],
    check=True,
)
print("favicon/favicon.ico")
