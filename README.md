# Zulfidraw

An Excalidraw-style whiteboard where everything snaps to an isometric grid. Draw
lines, polygons, elbow arrows, extruded boxes and text on a triangular lattice,
and they stay locked to the three isometric axes.

Flask + SQLite on the back end, a hand-rolled SVG canvas on the front (no canvas
library, no build step for the app code); htmx drives the drawing-management UI.

## Quick start

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py                     # http://127.0.0.1:8080
```

The SQLite database is created on first run (`zulfidraw.db`, next to `app.py`).

Environment: `PORT` (default 8080), `HOST` (default 127.0.0.1 — set to `0.0.0.0`
to expose it), `ZULFIDRAW_DB` to put the database somewhere else.

## Using it

| | |
|---|---|
| `V` / `H` | select / pan (or hold space to pan) |
| `L` / `P` | line / polygon — click points, `Enter` or click the start to close |
| `A` | arrow — drag for a straight one, or click points for an elbow |
| `B` | iso box — drag the footprint, then move up to set height |
| `T` | text |
| `1`–`7` | the same seven tools, by position |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo (`Ctrl+Y` also redoes) |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copy / cut / paste |
| `Ctrl+D` / `Ctrl+A` | duplicate / select all |
| `Ctrl+]` / `Ctrl+[` | raise / lower (add `Shift` for front / back) |
| arrows | nudge one lattice step (hold `Alt` for one pixel) |
| `Delete` / `Escape` | delete selection / cancel what you're drawing |

While you drag a shape out (or resize one), a label next to the cursor shows its
size in grid units — lines and polygon segments read as their iso-axis
decomposition, boxes as `a×b×c` — so you can draw to scale.

Marquee-select with the select tool, restyle the selection from the left panel
(stroke, fill, width, dashes, edges, arrowheads, font size, opacity, z-order),
and export the drawing as an SVG from the menu. Stroke widths and font sizes are
tuned so a large (~100×100 cell) drawing stays legible when zoomed to fit, and
arrowheads scale with stroke width. The font-size control appears when the text
tool is active or a text shape is selected.

Edits autosave about a second after you stop. Because autosave overwrites the
document, the server also keeps snapshots — one per minute of active editing,
newest 12 kept, plus an unconditional one before any save that drops half the
shapes. Restore them from **Version history** in the menu.

## Development

The CSS is Tailwind, compiled to `static/css/app.css` (committed, so the app runs
without touching npm). If you edit templates or JS, rebuild it:

```sh
npm install
npm run build      # or: npm run watch
```

The tests are Puppeteer scripts that drive a real browser against a running
server. Start the app first, then:

```sh
npm test                                  # or: node tests/test_e2e.js
BASE_URL=http://localhost:5000 npm test   # if it's not on :8080
```

They point at `http://localhost:8080` and the local `zulfidraw.db` by default;
override with `BASE_URL` and `ZULFIDRAW_DB`. Screenshots are written to the
system temp dir (`SHOT_DIR` to change that).

## License

MIT
