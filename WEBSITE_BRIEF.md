# iEdit website, build brief

Handoff doc for a brand new website building session. You're building a one
page marketing site for **iEdit**, the iMessage native AI video editor whose
backend lives in [this repo](https://github.com/rayidali/linqassignment1).
Read it end to end before writing code.

The brief separates **immutables** (brand, tone, the primary CTA, the content
the page must convey) from **open design space** (layout, typography choices,
visual treatment, framework). Treat the immutables as constraints; everything
else is yours to design.

## What you're building (one sentence)

A mobile first, single page landing site for iEdit whose primary job is to
get visitors to tap a button that opens iMessage to the demo number.

## The product (so you know what you're selling)

iEdit is an AI video editor that lives in iMessage. A user texts a demo
number a few clips and a caption (*"hype gym edit with bold text"*), and a
couple of minutes later they get back a TikTok style edited video with
music, text overlays, color grade, and pacing. They can reply *"make the
text yellow"* or *"different music"* and it re-renders. It's already
deployed and works end to end. The backend repo's README has the full
technical story if you want it.

---

## Immutables

### Primary CTA

The one thing every visitor should do: **tap a button that opens iMessage
to +1 (650) 468-7059**. On iPhone and Mac an `<a href="sms:+16504687059">`
does this natively. A QR code encoding the same `sms:` URL is the desktop
fallback.

Make it impossible to miss. If you do nothing else right, get this right.

### Brand identifiers

* **Name:** iEdit (one word, capital E).
* **Tagline (working):** "An AI video editor that lives in iMessage."
* **Sub tagline (working):** "Text it a few clips and a caption. Get back a
  finished video."
* **Brand color palette** (use freely, emphasize as you like):
  * Brand blue gradient: `#42A5F5` → `#1976D2`
  * Apple iMessage blue: `#007AFF`
  * Cyan accents (good for shader / gradient treatments): `#39CDFF`,
    `#72FFFC`
  * White `#FFFFFF`
  * Near black text on white: `#0A0A0A`. Subtle gray for sub copy:
    `#71717A`

### Tone (this matters more than visual style)

* Casual, direct, slightly gen z, never cringe. Short sentences.
* **No em-dashes anywhere.** Use commas, periods, or rewrite.
* Minimal hyphens. Write "fast paced", not "fast-paced".
* Show, don't tell. Examples beat adjectives.
* Words to avoid: *robust, powerful, seamless, revolutionary, AI powered,
  blazing fast, game changer*. Just say what it does.
* **Never write "Built with Claude Code"** anywhere on the site.

### Content the page must convey

Layout and order are open. Anywhere on the page, in whatever shape works
for your design, the visitor should walk away knowing:

* **What it is.** Name, one-line tagline, a glance at what the product does.
* **How to try it.** The CTA. The phone number visible somewhere. A QR for
  desktop visitors. (See "Primary CTA" above.)
* **What it can make.** At least one concrete example of *"caption →
  finished video"*. Two or three is ideal. Real screenshots or video
  thumbnails beat mockups. (Real assets are listed under "Assets you'll
  need to capture".)
* **How it works, briefly.** Text it clips + a caption → Claude plans the
  edit → you get the finished video back → reply with tweaks and it
  re-renders. Doesn't need to be a numbered list; can be three sentences,
  three cards, an animation, whatever.
* **What it understands.** A glance at the surface area, so visitors see
  it's not a one-trick demo: styles, music matching, pacing, speed,
  color, transitions, motion, text overlays (any open license font),
  multi turn refinement. The full list is in the README's "What it
  understands" table; pull from it.
* **Demo limits.** One line of small print. *"50 edits per person per day.
  Royalty free music only. Best on iPhone."*
* **A link to the GitHub repo.** Subtle is fine.
* **Credit.** Your name or handle, year. That's it.

---

## Open design space

### Visual direction (pick one or invent something)

Whatever fits the brand and ships fast. Some directions worth considering:

* **Shader gradient hero.** `@shadergradient/react` (the
  [ruucm/shadergradient](https://github.com/ruucm/shadergradient) lib)
  gives you an animated WebGL gradient. The user pre-tuned a config they
  like:

  ```jsx
  <ShaderGradient
    animate="on"
    color1="#007AFF"
    color2="#39CDFF"
    color3="#72FFFC"
    cAzimuthAngle={180}
    cDistance={3.6}
    cPolarAngle={90}
    cameraZoom={1}
    brightness={0.9}
    grain="on"
    lightType="3d"
    envPreset="city"
    type="plane"
    shader="defaults"
    uAmplitude={1}
    uDensity={1.3}
    uFrequency={5.5}
    uSpeed={0.2}
    uStrength={4}
    positionX={-1.4}
    positionY={0}
    positionZ={0}
    rotationX={0}
    rotationY={10}
    rotationZ={50}
    reflection={0.1}
    fov={45}
    pixelDensity={1}
    destination="onCanvas"
    embedMode="off"
    format="gif"
    frameRate={10}
  />
  ```

  Use it as a hero backdrop with the logo and CTA layered on top. The
  config is a starting point; tweak freely. Requires React (Next.js, Remix,
  or a React island in Astro).

* **CSS / mesh gradient.** No WebGL, no React requirement. Tools like
  [Mesh.cool](https://meshgradient.com), CSS conic gradients, or hand
  authored multi stop gradients can get you a similar feel with much less
  weight.

* **A real video loop.** A muted, looping clip from an actual iEdit output
  (when available) as the hero background. Most "showy" but heaviest.

* **Minimalist.** Plain white or near black background, brand color used
  only for the CTA and accents. Defaults to "looks intentional" with the
  least effort.

Bias toward whatever you can ship cleanly. A gorgeous shader hero you can't
finish loses to a clean gradient that ships.

### Typography

Open. The product feels native to iMessage, so a system font stack is a
strong default. If you reach for a custom typeface, **Inter** is the safe
choice; **Geist** / **Geist Mono**, **General Sans**, or **Söhne** are all
fine. Avoid Google Fonts that scream "tech blog circa 2018" (Roboto, Open
Sans, Lato).

### Tech stack

Recommendations, not rules:

* **Astro + Tailwind** if you want a static site, near zero JS, and you're
  not committing to shader-gradient (which wants React).
* **Next.js (App Router) + Tailwind** if you do want the shader gradient or
  any other React-only library. Vercel deploy is one click.
* Hosting: **Vercel** or **Netlify**, free tier is plenty.
* Domain: check `iedit.app` / `iedit.video` / `iedit.chat` on Cloudflare or
  Namecheap. `iedit.vercel.app` is fine for now.

Avoid: a CMS (no content to manage), Webflow (you already have code
control).

### Page structure

There is no prescribed order. Single scrolling page; sectioned or
continuous, your call. The only structural constraint: the CTA should be
visible (or one short scroll away) on first load.

---

## Reference SVG assets

The backend repo ships logo / CTA pill / QR as SVGs you can copy. Use them
as is, or remix them.

### Logo (copy this verbatim if you want)

```svg
<svg viewBox="0 0 680 480" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="appleBlue" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#42A5F5"/>
      <stop offset="100%" stop-color="#1976D2"/>
    </linearGradient>
  </defs>
  <g transform="translate(340, 240)">
    <path d="M 0,-140 C 77,-140 140,-77 140,0 C 140,77 77,140 0,140 C -30,140 -58,131 -82,116 C -95,124 -118,132 -135,134 C -128,124 -120,110 -116,96 C -132,76 -140,40 -140,0 C -140,-77 -77,-140 0,-140 Z" fill="url(#appleBlue)"/>
    <path d="M -26,-42 L 50,0 L -26,42 Z" fill="#FFFFFF"/>
  </g>
</svg>
```

### CTA pill (reference; redesign as needed)

This is the "Try it here" pill from the README. Fine to use as a static
asset; better to re-implement as an HTML button with proper hover, active,
and focus-visible states, plus a real focus ring. The SVG below is purely a
visual reference for the look.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 88" role="img" aria-label="Try it here">
  <defs>
    <linearGradient id="imsgBg" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#5AB1FF"/>
      <stop offset="100%" stop-color="#1976D2"/>
    </linearGradient>
    <linearGradient id="imsgHi" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="imsgShadow" x="-20%" y="-20%" width="140%" height="170%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#0D47A1" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect x="10" y="8" width="240" height="72" rx="36" ry="36" fill="url(#imsgBg)" filter="url(#imsgShadow)"/>
  <rect x="10" y="8" width="240" height="36" rx="36" ry="36" fill="url(#imsgHi)"/>
  <g transform="translate(64, 44)" fill="#FFFFFF">
    <rect x="-16" y="-13" width="32" height="22" rx="6"/>
    <path d="M -11,8 L -16,15 L -3,8 Z"/>
  </g>
  <text x="92" y="44"
        font-family="system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        font-size="22" font-weight="600" letter-spacing="0.2"
        fill="#FFFFFF"
        dominant-baseline="central">Try it here</text>
</svg>
```

### QR code

Brand blue QR encoding `sms:+16504687059` lives in the backend repo at
`assets/imessage-qr.svg`. Copy it over. To regenerate for a different
demo number:

```bash
npx -p qrcode -- qrcode "sms:+1NEWNUMBER" -t svg -d 1976D2 -l FFFFFF -o public/imessage-qr.svg
```

---

## Assets you'll need to capture before launch

Without at least one or two of these the site will feel hollow.

1. **A real video output.** The best edit the bot has made for you. Five to
   fifteen seconds. Compress with HandBrake (Web → Vimeo 1080p preset) before
   shipping. Embed muted + loop, or as a poster image with click to play.
2. **iMessage conversation screenshots.** Real exchanges, cropped tight.
   These show actual product behavior, not a mockup. The single most
   convincing thing you can put on the page.
3. **A composed hero shot (optional).** A phone mock with the iMessage
   conversation visible and the rendered video playing in the bubble.
   Nano Banana Pro can render this from a screenshot plus a prompt.

Prioritize at least one real screenshot.

---

## Things to absolutely not do

* Em-dashes anywhere in copy.
* The phrase "AI-powered video editor" or any variant.
* A newsletter signup, pricing table, testimonials, or feature comparison
  table. It's a demo, not a SaaS launch.
* Tracking that requires a cookie banner. Plausible (cookie free) is fine
  if you want analytics; otherwise skip.
* Autoplay video with sound. Muted, looped, `playsinline` only.
* A "Built with Claude Code" footer.

---

## Reference links

* **Backend GitHub repo:** https://github.com/rayidali/linqassignment1
* **Backend live URL:** https://linq-video-editor.onrender.com
  (`/healthz`, `/version`; not user facing)
* **Demo phone:** `+1 (650) 468-7059` (may rotate; check the repo README
  for the current number)
* **ShaderGradient lib:** https://github.com/ruucm/shadergradient

## Out of scope for v1

* User auth, dashboards, account pages.
* A blog or changelog.
* Multi language support.
* A pricing page (it's a free demo).
