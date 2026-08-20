# shaunjayachandran.com

Personal site for Shaun Jayachandran — Founder & CEO, Crossover Basketball and
Scholars Academy, and AI Product Advisor at GameRun.ai. Static HTML/CSS/JS,
no build step required.

## Why this content

The original site (`sites.google.com/view/shaunjayachandran`) wasn't
reachable from this environment's network, so this version was rebuilt from
verified public sources (LinkedIn, GameRun.ai, Crossover Basketball's site,
and press coverage — linked in the Press section). **Before publishing,
please review every section for accuracy** — titles, dates, stats, and bio
details — and swap in a real headshot photo in place of the "SJ" monogram.

## Structure

```
index.html      All page content/sections
css/style.css   Styling (single stylesheet, CSS variables at the top)
js/main.js      Mobile nav toggle + scroll-reveal animation
images/         favicon.svg, og-card.svg (social preview card)
vercel.json     Basic security headers
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

- Update copy directly in `index.html` (sections are labeled with HTML comments
  via their `id`s: `about`, `impact`, `experience`, `speaking`, `press`, `contact`).
- Swap the monogram in the About section for a real photo by replacing the
  `.monogram` div with an `<img>` tag.
- Colors/fonts live as CSS variables at the top of `css/style.css`.
