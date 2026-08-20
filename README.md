# shaunjayachandran.com

Speaker/personal site for Shaun Jayachandran — Founder & Executive Director,
Hoops Creating Hope, and Senior Product Manager at GameRun.ai. Static
HTML/CSS/JS, no build step required.

## Why this content

The original site (`sites.google.com/view/shaunjayachandran`) wasn't
reachable from this environment's network. Content was rebuilt to match
screenshots of the live site provided directly, so copy, pricing, and
credentials should match the source closely. Photos referenced on the
original site were broken/unavailable, so this version uses labeled
placeholder blocks (`.photo-placeholder`) in their place —
**swap in real photos before publishing.**

## Structure

```
index.html                  Home: hero, speaking topics (3 tiers + tracks), why book Shaun, stats
about.html                  About Shaun: bio + background & credentials
hoops-creating-hope.html    Hoops Creating Hope: org overview + impact stats
book.html                   Book Now: stats banner + booking CTA + contact
css/style.css               Styling (single stylesheet, CSS variables at the top)
js/main.js                  Mobile nav toggle + scroll-reveal animation
images/                     favicon.svg, og-card.svg (social preview card)
vercel.json                 Basic security headers
```

## Local preview

Any static server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Deploy to Vercel

**Option A — Vercel CLI**
```bash
npm i -g vercel
vercel        # first deploy, follow prompts (framework: Other)
vercel --prod # promote to production
```

**Option B — Git integration**
1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In the Vercel dashboard: New Project → Import this repo.
3. Framework Preset: **Other**. No build command needed — it's static.
4. Deploy. Every push to the connected branch will auto-deploy.

## Customizing

- Each page's copy is directly in its HTML file — no templating/build step.
- Replace `.photo-placeholder` divs with real `<img>` tags once photos are available.
- Colors/fonts live as CSS variables at the top of `css/style.css`.
- The "Request Speaking Engagement" and "Book Me to Speak" buttons are `mailto:`
  links today. Wire up a real form/service if you want submissions captured.
