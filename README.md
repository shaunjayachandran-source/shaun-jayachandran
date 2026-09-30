# Shaun Jayachandran: personal site

Static HTML/CSS/JS, no build step. Deployed on Vercel from this repo.

## Pages

```
index.html                Homepage: product-leadership first, with doors to speaking and Hoops Creating Hope
talks.html                Speaking: keynotes, workshops, and the booking form (Formspree)
robots.txt, sitemap.xml   Crawler hints (update the domain here if a custom domain is attached)
resume.pdf                Linked from the hero. Add this file; the link 404s until it exists.
```

`index.html` and `talks.html` each carry their own inline `<style>`; there is no shared stylesheet.

## Assets

```
images/web/               Optimized WebP photos with responsive widths (<name>-480/800/1200.webp),
                          video poster frames (yt-<id>.webp), and the FIBA logo
images/og-image.jpg       1200x630 social share image (JPEG for widest crawler support)
images/*.png, *.mp4       Logo strip assets
```

To add or replace a photo, export WebP at 480w and 800w (plus 1200w for large hero-style
images), name them `<name>-<width>.webp`, and reference them with `srcset`. Keep below-fold
images `loading="lazy"`; only the hero image is eager.

## Embeds

YouTube videos and the speaker reel (TikTok) are click-to-load. Nothing from those hosts is
requested until a visitor presses play. To change a video, edit the `data-yt="<id>"`
attribute (and swap the poster in `images/web/`).

## Legacy files (not linked from the site)

`about.html`, `book.html`, `hoops-creating-hope.html`, `css/style.css`, `js/main.js`,
`extras.css`, `extras.js`, and the original full-size photos in `images/` are left over from
earlier versions. They are safe to delete once you no longer need them.

## Local preview

```bash
python3 -m http.server 8000
```
