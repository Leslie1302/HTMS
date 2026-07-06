# Hyperframes Composition Brief: HTMS

## Objective
A cinematic launch-style brag video for HTMS — the Ministry of Energy (Ghana) haulage payment system.

## Output
- Composition directory: composition/
- Rendered video: brag.mp4
- Format: landscape — 1920x1080
- Duration: 20s

## Source Material
- Product name: HTMS (Haulage Transport Management System)
- Tagline (verbatim): "From waybill to cedi — without the paper chase."
- Key visual recreated: the real Ghana map + a truck driving pin-to-pin (Tema → Kumasi → Tamale), the invoice/letter document previews, the Ghana flag stripe.
- Copy that appears verbatim: "From waybill to cedi — without the paper chase.", "Ministry of Energy & Green Transition · Ghana", "FIDIC-INDEXED COSTING.", "GENERATED. NOT TYPED."

## Creative Direction
- Tone: cinematic — trailer-scale, big caps, dramatic reveals, each line lands before the next.
- Hook: dark screen, Ghana map strokes in and a truck rolls from Tema; "HAULAGE PAYMENTS." → "STILL ON PAPER."
- Outro: HTMS slams full-screen, Ghana flag stripe sweeps, tagline, ministry line.
- Avoid: generic SaaS language, abstract filler, equalizer/particle clichés.

## Visual Identity
- Background: #0f1523 / #141b2b
- Accent: #2e7d32 / #0d631b (Ministry green); Ghana flag #ce1126 / #fcd116 / #006b3f
- Text: #ffffff, muted at ~62%
- Display: heavy caps sans; Body: system-ui

## Storyboard
See brag-plan.md (5 scenes, 20s). Scene summary:
1. Map draws + truck / "still on paper" — 4s
2. HTMS wordmark reveal — 4s (beat-lock ~4.30s)
3. FIDIC-indexed cost count-up to GHS 23,697.61 — 4s
4. Invoice + letter documents arrive + chips — 4.5s
5. Logo slam + flag stripe + tagline — 3.5s (beat-lock ~16.6s)

## Audio
- Music: assets/music/track.mp3 (happy-beats-business-moves vol 1), ~0.7 vol, swell intent on the outro.
- SFX: to be chosen by Hyperframes (map whoosh, card sounds on doc reveal, final hit).
- Beat sync: run `npx hyperframes beats` and nudge the wordmark (Scene 2) and final slam (Scene 5) to strong beats; snap the cost ticks / doc cards to the beat grid.
- Audio-reactive: subtle glow on the map / wordmark if extraction available.

## Notes
Composition passes `hyperframes lint` (0 errors). `validate` + `render` require headless Chrome, which was unavailable in the build sandbox (Linux ARM64). Render locally per README.
