const puppeteer = require("puppeteer");
const path = require("path");

const BASE = process.env.BASE_URL || "http://localhost:8080";
const SHOTS = process.env.SHOT_DIR || require("os").tmpdir();

(async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  const target = await page.evaluate(async () =>
    (await fetch("/drawings", { method: "POST" })).headers.get("hx-redirect"));
  await page.goto(BASE + target, { waitUntil: "networkidle0" });

  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1); await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 10 }); await page.mouse.up();
  };
  const count = () => page.$$eval("#shapesLayer > g", e => e.length);
  const selCount = () => page.$$eval("#overlayLayer rect[stroke-dasharray]", e => e.length);
  const positions = () => page.$$eval("#shapesLayer > g", els =>
    els.map(g => { const r = g.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));

  // three shapes spread across the canvas
  await page.keyboard.press("l");
  await drag(300, 300, 400, 250);         // A (left)
  await page.keyboard.press("l");
  await drag(450, 320, 550, 260);         // B (middle)
  await page.keyboard.press("l");
  await drag(900, 600, 1000, 550);        // C (far away)
  const drawn = await count();

  // marquee across A and B only (empty-space drag)
  await page.keyboard.press("v");
  await drag(250, 200, 600, 380);
  const afterMarquee = await selCount();
  const marqueeGone = await page.$$eval("#tempLayer rect", e => e.length);

  // shift-marquee adds C
  await page.keyboard.down("Shift");
  await drag(850, 500, 1050, 650);
  await page.keyboard.up("Shift");
  const afterShift = await selCount();

  // marquee on empty space clears
  await drag(100, 700, 150, 750);
  const afterEmpty = await selCount();

  // re-marquee A+B, then move them together with the mouse
  await drag(250, 200, 600, 380);
  const before = await positions();
  await drag(350, 280, 350 + 41.57, 280); // grab shape A, drag one lattice step right
  const after = await positions();
  const moved = before.map((p, i) => [after[i][0] - p[0], after[i][1] - p[1]]);

  // copy the pair, paste at cursor, expect 2 new shapes and 2 selected
  await page.keyboard.down("Control"); await page.keyboard.press("c"); await page.keyboard.up("Control");
  await page.mouse.move(700, 650);
  const clip = await page.evaluate(() => window.__clip);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "");   // force the internal-cache fallback path
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  const afterPaste = await count();
  const pastedSel = await selCount();

  // arrow-nudge all pasted shapes at once
  const bN = await positions();
  await page.keyboard.press("ArrowDown");
  const aN = await positions();
  const nudged = bN.map((p, i) => aN[i][1] - p[1]);

  // delete the pasted pair
  await page.keyboard.press("Delete");
  const afterDelete = await count();

  await new Promise(r => setTimeout(r, 1100));
  const status = await page.$eval("#saveStatus", el => el.textContent);
  await page.screenshot({ path: path.join(SHOTS, "zulfidraw-marquee.png") });

  console.log(JSON.stringify({
    drawn, selectedByMarquee: afterMarquee, marqueeRectCleared: marqueeGone === 0,
    afterShiftAdd: afterShift, afterEmptyDrag: afterEmpty,
    movedDeltas: moved, afterPaste, pastedSelected: pastedSel,
    nudgedDeltas: nudged, afterDelete, status, errors,
  }, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
