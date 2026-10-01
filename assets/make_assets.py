#!/usr/bin/env python3
"""Regenerate the README header art (hero-dark.svg, hero-light.svg). Stdlib only."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# GitHub-like neutrals with one teal accent (GitHub's own "done" teal family).
THEMES = {
    "dark": dict(bg="#0d1117", panel="#161b22", line="#30363d", text="#e6edf3", dim="#8b949e",
                 accent="#39c5cf"),
    "light": dict(bg="#ffffff", panel="#f6f8fa", line="#d0d7de", text="#1f2328", dim="#656d76",
                  accent="#1b7c83"),
}
FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"


def box(x, y, w, h, label, sub, c, stroke, sub2=""):
    out = (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{c["panel"]}" stroke="{stroke}" stroke-width="1.5"/>'
           f'<text x="{x + w / 2}" y="{y + 30}" text-anchor="middle" font-family="{FONT}" font-size="17" font-weight="600" fill="{c["text"]}">{label}</text>'
           f'<text x="{x + w / 2}" y="{y + 52}" text-anchor="middle" font-family="{FONT}" font-size="12.5" fill="{c["dim"]}">{sub}</text>')
    if sub2:
        out += f'<text x="{x + w / 2}" y="{y + 69}" text-anchor="middle" font-family="{FONT}" font-size="12.5" fill="{c["dim"]}">{sub2}</text>'
    return out


def arrow(x1, y1, x2, y2, color, dashed=False):
    dash = ' stroke-dasharray="5 4"' if dashed else ""
    if x2 >= x1:
        return (f'<line x1="{x1}" y1="{y1}" x2="{x2 - 7}" y2="{y2}" stroke="{color}" stroke-width="1.8"{dash}/>'
                f'<path d="M{x2 - 8},{y2 - 5} L{x2},{y2} L{x2 - 8},{y2 + 5} Z" fill="{color}"/>')
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2 + 7}" y2="{y2}" stroke="{color}" stroke-width="1.8"{dash}/>'
            f'<path d="M{x2 + 8},{y2 - 5} L{x2},{y2} L{x2 + 8},{y2 + 5} Z" fill="{color}"/>')


def hero(c):
    W, H = 1200, 330
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
         'aria-label="even-hermes: smart glasses talk to the Even app, which talks to Even Terminal on your machine; '
         'Even Terminal runs the even-hermes shim as codex app-server, and the shim drives the Hermes gateway">',
         f'<rect width="{W}" height="{H}" rx="16" fill="{c["bg"]}" stroke="{c["line"]}"/>',
         f'<text x="60" y="78" font-family="{MONO}" font-size="38" font-weight="700" fill="{c["text"]}">even-hermes</text>',
         f'<text x="60" y="112" font-family="{FONT}" font-size="18" fill="{c["dim"]}">'
         'Your Hermes Agent on Even Realities glasses, through Even Terminal, with no patches to Even Terminal.</text>']
    y, h, w, gap, x0 = 158, 80, 186, 42, 60
    nodes = [("glasses", "the HUD", "", c["line"]),
             ("Even app", "on your phone", "", c["line"]),
             ("Even Terminal", "on your machine", "", c["line"]),
             ("even-hermes", "codex app-server shim", "+ claude stream-json shim", c["accent"]),
             ("Hermes", "tui_gateway over stdio", "or a dashboard over ws", c["line"])]
    xs = [x0 + i * (w + gap) for i in range(len(nodes))]
    for x, (label, sub, sub2, stroke) in zip(xs, nodes):
        s.append(box(x, y, w, h, label, sub, c, stroke, sub2))
    for i in range(1, len(xs)):
        s.append(arrow(xs[i] - gap, y + 30, xs[i], y + 30, c["dim"]))
    # return path: everything Hermes sends back ends up as HUD rows
    ry = y + h + 30
    s.append(arrow(xs[-1] + w / 2, ry, xs[0] + w / 2, ry, c["accent"], dashed=True))
    s.append(f'<line x1="{xs[-1] + w / 2}" y1="{y + h}" x2="{xs[-1] + w / 2}" y2="{ry}" stroke="{c["accent"]}" stroke-width="1.8" stroke-dasharray="5 4"/>')
    s.append(f'<line x1="{xs[0] + w / 2}" y1="{y + h}" x2="{xs[0] + w / 2}" y2="{ry - 1}" stroke="{c["accent"]}" stroke-width="1.8" stroke-dasharray="5 4"/>')
    s.append(f'<rect x="{W / 2 - 245}" y="{ry - 12}" width="490" height="24" fill="{c["bg"]}"/>')
    s.append(f'<text x="{W / 2}" y="{ry + 5}" text-anchor="middle" font-family="{FONT}" font-size="13.5" fill="{c["text"]}">'
             'tool rows, status, approvals, questions and the reply come back to the HUD</text>')
    s.append("</svg>")
    return "".join(s)


for theme, colors in THEMES.items():
    with open(os.path.join(HERE, f"hero-{theme}.svg"), "w", encoding="utf-8") as f:
        f.write(hero(colors))
print("ok")
