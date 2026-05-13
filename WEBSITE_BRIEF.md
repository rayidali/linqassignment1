# iEdit website, build brief

Handoff doc for a brand new website building session. You're building a one
page marketing site for **iEdit**, the iMessage native AI video editor whose
backend lives in [this repo](https://github.com/rayidali/linqassignment1).
Treat this doc as the source of truth; read it end to end before writing code.

## What you're building (one sentence)

A mobile first, single page landing site for iEdit whose primary job is to get
visitors to tap a button that opens iMessage to the demo number.

## The product (so you know what you're selling)

iEdit is an AI video editor that lives in iMessage. A user texts a demo number
a few clips and a caption (*"hype gym edit with bold text"*), and a couple of
minutes later they get back a TikTok style edited video with music, text
overlays, color grade, and pacing. They can reply *"make the text yellow"* or
*"different music"* and it re-renders. It's already deployed and works end to
end. The backend repo's README has the full technical story if you want it.

## Primary CTA

The one thing every visitor should do: **tap a button that opens iMessage to
+1 (650) 468-7059**. On iPhone and Mac an `<a href="sms:+16504687059">` does
this natively. A QR code encoding the same `sms:` URL is the desktop fallback.
If you do nothing else right, get this one right.

## Brand

* **Name:** iEdit (one word, capital E).
* **Tagline (working):** "An AI video editor that lives in iMessage."
* **Sub tagline:** "Text it a few clips and a caption. Get back a finished video."
* **Colors:**
  * Brand blue gradient: `#42A5F5` (top) → `#1976D2` (bottom). Use it on the
    logo, the CTA pill, and any hero accents.
  * White `#FFFFFF` for surfaces and inverted text.
  * Near black text on white: `#0A0A0A`. Subtle gray for sub copy: `#71717A`.
* **Type:** System font stack. The product feels native to iMessage, so don't
  pull a custom display font. If you must, **Inter** is the safe choice.
  ```
  system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
  ```
* **Tone:** Casual, direct, slightly gen z, never cringe. Short sentences.
  **No em-dashes.** Minimal hyphens (write "fast paced" not "fast-paced").
  Show, don't tell. Examples beat adjectives.
* **Words to avoid in copy:** *robust, powerful, seamless, revolutionary, AI
  powered, blazing fast, game changer*. Just say what it does.

## Logo (copy this verbatim into the site project)

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

## CTA pill (reference SVG)

Rendered natural size 260×88. Wrap in `<a href="sms:+16504687059">`. For a
real website, re-implement as an HTML button so you get proper `:hover` /
`:active` / focus ring states; this SVG is fine for static contexts.

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

## QR code

There's a brand blue QR encoding `sms:+16504687059` in the backend repo at
`assets/imessage-qr.svg`. Copy it over. To regenerate for a different demo
number:

```bash
npx -p qrcode -- qrcode "sms:+1NEWNUMBER" -t svg -d 1976D2 -l FFFFFF -o public/imessage-qr.svg
```

## Page structure

Single scrollable landing page. Section order below. Prune ruthlessly; if a
section doesn't earn its space, cut it.

### 1. Hero (above the fold)
* Centered logo at ~120px, "iEdit" wordmark below it.
* Tagline and sub tagline.
* The CTA pill. Below it in small type: `+1 (650) 468-7059` and a note
  "demo line, may rotate".
* QR code visible on desktop, hidden on mobile (mobile users will tap).

### 2. Examples strip ("what you send, what you get back")
This is what sells the product. Three or four short cards in a row (stacked
on mobile). Each card shows on the left an iMessage style bubble with the
user's caption, and on the right a thumbnail of the resulting video.
Suggested examples:
* "christmas edit with bold text" → festive carol montage
* "slow mo cinematic black and white" → moody single clip
* "recap of my trip from these pics" → carousel of stills with zoom
* "make the text yellow" → an updated video (shows the refinement flow)

### 3. How it works (compact, three steps)
1. **Text it your clips and a caption.** *"hype gym edit, big bold text"*
2. **Claude plans the edit.** It picks the music, the pacing, the overlays,
   the color grade.
3. **You get the finished video back.** Reply with tweaks and it re-renders.

### 4. What it understands (grid)
Pull from the README's "What it understands" table. Styles, music, pacing,
speed, color, transitions, motion, text overlays, multi turn. Two columns
on desktop, one on mobile.

### 5. CTA repeat
Same big button, same QR. One line of fine print: *"Demo limits: 50 edits
per person per day. Royalty free music only. Best on iPhone."*

### 6. Footer
Tiny. Your name / handle, year, a link to the GitHub repo. That's it. **Do
not** write "Built with Claude Code" anywhere.

## Things to absolutely not do

* No em-dashes in copy. Use commas, periods, or rewrite the sentence.
* No stock photo hero imagery. Use the logo, the SVGs, and (when you have
  them) real screenshots.
* No "AI-powered video editor" or any variant. The product is *an AI video
  editor*.
* No newsletter signup, pricing table, testimonials, or feature comparison
  table. It's a demo, not a SaaS launch.
* No tracking that requires a cookie banner. If you want analytics, use
  Plausible (cookie free). Otherwise skip.
* No autoplay video with sound. Muted, looped, `playsinline` only.

## Tech stack (recommended)

Opinionated. Push back only with a good reason.

* **Framework:** [Astro](https://astro.build). Beats Next.js for a content
  heavy single page site, ships near zero JS, builds to static HTML, hits
  perfect Lighthouse scores out of the box.
* **Styling:** Tailwind CSS (`npx astro add tailwind`).
* **Hosting:** Vercel or Netlify. One click Astro deploy on either, free
  tier is plenty.
* **Don't reach for:** Next.js (overkill, too much JS), a CMS (no content
  to manage), Webflow (you have full code control already).
* **Domain (optional):** check `iedit.app`, `iedit.video`, `iedit.chat` on
  Cloudflare or Namecheap. Otherwise `iedit.vercel.app` is fine for now.

## Assets you'll need to capture before launch

Without at least one or two of these the site will feel hollow.

1. **A real video output.** The best edit the bot has made for you. 5 to 15
   seconds. Compress with HandBrake (Web → Vimeo 1080p preset) before
   shipping. Embed muted+loop, or as a poster+click to play.
2. **iMessage conversation screenshots.** Real exchanges, cropped tight.
   These show actual product behavior, not a mockup. Gold.
3. **A composed hero shot (optional, nice).** A phone mock with the iMessage
   conversation visible and the rendered video playing in the bubble. Nano
   Banana Pro can render this from a screenshot plus a prompt.

Prioritize at least one real screenshot in section 2.

## Reference links

* **Backend GitHub repo:** https://github.com/rayidali/linqassignment1
* **Backend live URL:** https://linq-video-editor.onrender.com
  (`/healthz`, `/version`; not user facing)
* **Demo phone:** `+1 (650) 468-7059` (may rotate; check the repo README for
  the current number)
* **Backend README:** the technical companion to this site

## Visual reference (for tone, not to copy)

* [Linear](https://linear.app), minimal and confident, lots of whitespace
* [Cron](https://cron.com), tiny landing page done well
* [Raycast](https://raycast.com), bold type, clean color blocks
* [Vercel](https://vercel.com), great "what it does" section with motion

Match the level of restraint. Don't clone the layouts.

## Out of scope for v1

* User auth, dashboards, account pages.
* A blog or changelog.
* Multi language support.
* A pricing page (it's a free demo).
