# ExplorAI world

A 3D website for ExplorAI, the AI club at Riverside City College. You walk a small mochi around a strawberry-matcha cake island; each pastry building is one part of the club. Prototype, October 2026.

Static files, no build step. Three.js 0.170.0 and the fonts load from CDNs, so it runs as-is on GitHub Pages.

## Run it locally

```sh
python3 -m http.server 8765
# open http://localhost:8765
```

It has to be served over http; opening `index.html` as a file blocks the module imports.

## Files

| File | What it holds |
|---|---|
| `index.html` | All the words on the site (one `<article class="station">` per place), the CSS, and the import map |
| `site.js` | Cards, the schedule, the vote, the text version. Works without WebGL |
| `world.js` | The 3D island. Loaded only when WebGL works; on failure the page falls back to the text version |

## Places

| Place | Building | From the decks |
|---|---|---|
| About | Strawberry shortcake with an ExplorAI cake topper | Title slide, meeting time |
| Meetings | Macaron tower, one macaron per meeting, flag on the next one | Thank-you slide's "Next week" card |
| Argue | Six macaron stepping stones, 0 to 5, and a tea table. Standing on a stone is a vote | Meeting 4's 0 to 5 vote bar and follow-up bubbles |
| Build | Oven with the recipe card taped on top, app-window cookies cooling | Meetings 3 and 5's recipe |
| Join | Bitten donut you walk into, Instagram and Discord lollipops | Closing slide QR codes, Meeting 2's officer roles |

Palette, fonts, grain, glow, taped notes, and bubbles come from the decks (pcolee/explorAI, Deck contract). Light theme only.

## Updating it

- **Each week:** add the meeting to `SCHEDULE.meetings` in `site.js` (the tower grows from this list) and add its note to the Meetings card in `index.html`.
- **Each term:** `start`, `end`, `room`, `off`, and `last` in `SCHEDULE`.
- **Discord invite** (`index.html`, Join card) expires; replace it whenever the decks' invite changes.
- `?text` in the URL opens the text version; `#meetings` (or any place id) starts at that place.

## Controls

Click or tap the ground to walk, click a building or a nav pill to go there, WASD or arrow keys to walk, drag to turn the camera, scroll or pinch to zoom, Esc closes the card.
