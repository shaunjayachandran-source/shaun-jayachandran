# Shaun Jayachandran: personal site

Static HTML/CSS/JS, no build step. Deployed on Vercel from this repo.

## Pages

```
index.html                Homepage: product leadership first, with doors to speaking and Hoops Creating Hope
talks.html                Speaking: past events, keynotes, workshops, and the booking form (Formspree)
resume.pdf                Linked from the hero "Download resume" button
robots.txt, sitemap.xml   Crawler hints (update the domain here if a custom domain is attached)
vercel.json               Security headers + redirects for retired pages (about, book, hoops-creating-hope)
```

`index.html` and `talks.html` each carry their own inline `<style>`; there is no shared stylesheet.

## Assets

```
images/web/               Optimized WebP photos (<name>-480/800/1200.webp), video posters, FIBA logo
images/og-share.jpg       1200x630 social share card (used by both pages' Open Graph / Twitter tags)
images/favicon.svg        SJ monogram; also favicon-32.png, apple-touch-icon.png, /favicon.ico
images/*.png, *.mp4       Logo strip assets
images/*.jpg|JPG|JPEG     Original full-size photos (source files for images/web; not loaded by the pages)
```

To add or replace a photo, export WebP at 480w and 800w (plus 1200w for wide images), name them
`<name>-<width>.webp`, and reference them with `srcset`. Keep below-fold images `loading="lazy"`.

If you change the share card, give it a new filename so LinkedIn, iMessage and Slack fetch it fresh,
then re-run LinkedIn's Post Inspector on the site URL.

## Embeds

YouTube videos and the speaker reel (TikTok) are click-to-load: nothing from those hosts is requested
until a visitor presses play. To change a video, edit the `data-yt="<id>"` attribute and swap the poster.

## Local preview

```bash
python3 -m http.server 8000
```
(Redirects in vercel.json only apply on Vercel, not in this local preview.)
