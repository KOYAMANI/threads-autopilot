#!/usr/bin/env python3
"""Build the Meta App Review screencast from two raw recordings.

Cuts the segments listed below, burns English captions (PIL images overlaid
with ffmpeg, since this ffmpeg has no drawtext/libass), blurs the clipboard
history menu that appears on the login screen, and concatenates everything.
Outputs one full video plus one clip per permission (intro + that section).
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

INTRO = "/Users/yutaro/Desktop/Screen Recording 2026-10-10 at 13.17.31.mov"
MAIN = "/Users/yutaro/Desktop/Screen Recording 2026-10-10 at 12.44.36.mov"
OUT = os.path.expanduser("~/Desktop/meta-review-2026-10-10")
WORK = os.path.join(OUT, "_work")
FONT = "/Library/Fonts/Arial Unicode.ttf"  # covers Latin and Japanese
W, H = 1920, 1080

# Blur boxes (x, y, w, h, start, end) in source seconds, intro only.
INTRO_BLUR = [(1100, 640, 820, 440, 19.0, 24.0), (1100, 745, 820, 335, 24.0, 26.8)]

# (group, source, start, end, caption)
SEGMENTS = [
    ("intro", "intro", 18.0, 28.5, "Threads Autopilot is a web app. The user first signs in to their own app account (email and password)."),
    ("intro", "intro", 28.5, 33.0, "The user clicks the purple \"Connect with Threads\" button to link their own Threads profile."),
    ("intro", "intro", 33.0, 38.5, "Meta's official Threads authorization screen lists every requested permission. The user grants access by clicking \"Continue as yama_threads.sub\"."),
    ("intro", "intro", 38.5, 44.0, "Connected. The app starts importing the user's own profile and posts."),
    ("basic", "main", 55.0, 70.0, "threads_basic: the Home screen shows the connected profile @yama_threads.sub and the user's own posts. \"Read full text\" opens a post."),
    ("insights", "main", 70.0, 110.0, "threads_manage_insights: the Analytics screen shows views, likes and followers for the user's own profile and posts. The user switches periods (7/30/90 days)."),
    ("publish", "main", 130.0, 153.0, "threads_content_publish: on the Create Post screen the user types a post and adds a follow-up post."),
    ("publish", "main", 153.0, 168.0, "The user saves it as a draft. Nothing is published until the user confirms."),
    ("publish", "main", 168.0, 180.0, "In the Drafts tab the user opens the actions menu and chooses \"Publish now\"."),
    ("publish", "main", 180.0, 192.0, "The confirmation dialog shows the target account and the full text. The user clicks the purple button to publish."),
    ("publish", "main", 493.0, 499.0, "A few minutes later the post appears in the Published tab."),
    ("replies", "main", 499.0, 524.0, "threads_manage_replies: on Threads, the follow-up was published as a reply from the same account under the root post (1/2, 2/2)."),
    ("read", "main", 524.0, 546.0, "threads_read_replies: the user clicks \"Sync now\". The app imports the user's own replies from Threads."),
    ("read", "main", 695.0, 728.0, "The app now shows the root post together with the user's own follow-up reply imported from Threads."),
]

def caption_png(text, path):
    img = Image.new("RGBA", (W, 170), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 170], fill=(0, 0, 0, 200))
    font = ImageFont.truetype(FONT, 40)
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=font) > W - 120:
            lines.append(cur); cur = w
        else:
            cur = t
    lines.append(cur)
    y = (170 - len(lines) * 52) // 2
    for ln in lines:
        x = (W - d.textlength(ln, font=font)) // 2
        d.text((x, y), ln, font=font, fill=(255, 255, 255, 255))
        y += 52
    img.save(path)

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr[-2000:])

def render(i, seg):
    group, src, a, b, text = seg
    cap = os.path.join(WORK, f"cap_{i:02d}.png")
    caption_png(text, cap)
    out = os.path.join(WORK, f"seg_{i:02d}.mp4")
    chain = f"[0:v]scale={W}:{H},fps=30,setsar=1[v0]"
    last = "v0"
    if src == "intro":
        for j, (x, y, w, h, s, e) in enumerate(INTRO_BLUR):
            if e <= a or s >= b:
                continue
            s2, e2 = max(s, a) - a, min(e, b) - a
            chain += (f";[{last}]split[m{j}][c{j}];[c{j}]crop={w}:{h}:{x}:{y},boxblur=30:3[bl{j}]"
                      f";[m{j}][bl{j}]overlay={x}:{y}:enable='between(t,{s2},{e2})'[b{j}]")
            last = f"b{j}"
    chain += f";[{last}][1:v]overlay=0:{H}-170[v]"
    run(["ffmpeg", "-v", "error", "-y", "-ss", str(a), "-to", str(b),
         "-i", INTRO if src == "intro" else MAIN, "-i", cap,
         "-filter_complex", chain, "-map", "[v]", "-an",
         "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p", out])
    return group, out

def concat(paths, out):
    lst = out + ".txt"
    with open(lst, "w") as f:
        f.writelines(f"file '{p}'\n" for p in paths)
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
    os.remove(lst)

def main():
    os.makedirs(WORK, exist_ok=True)
    rendered = [render(i, s) for i, s in enumerate(SEGMENTS)]
    concat([p for _, p in rendered], os.path.join(OUT, "00_full_end_to_end.mp4"))
    intro = [p for g, p in rendered if g == "intro"]
    names = {"basic": "threads_basic", "insights": "threads_manage_insights",
             "publish": "threads_content_publish", "replies": "threads_manage_replies",
             "read": "threads_read_replies"}
    for g, n in names.items():
        parts = [p for gg, p in rendered if gg == g]
        if g == "replies":  # the reply is created by the publish flow
            parts = [p for gg, p in rendered if gg == "publish"] + parts
        concat(intro + parts, os.path.join(OUT, f"{n}.mp4"))
    print("done:", OUT)

if __name__ == "__main__":
    main()
