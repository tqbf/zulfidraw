const puppeteer = require("puppeteer");
const path = require("path");

const BASE = process.env.BASE_URL || "http://localhost:8080";
const SHOTS = process.env.SHOT_DIR || require("os").tmpdir();

(async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  await browser.defaultBrowserContext().overridePermissions(BASE, ["clipboard-read", "clipboard-write"]);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  // fresh drawing
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  const target = await page.evaluate(async () =>
    (await fetch("/drawings", { method: "POST" })).headers.get("hx-redirect"));
  await page.goto(BASE + target, { waitUntil: "networkidle0" });

  const count = () => page.$$eval("#shapesLayer > g", els => els.length);
  const firstBox = () => page.evaluate(() => {
    const r = document.querySelector("#shapesLayer > g").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1); await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up();
  };

  // draw a box
  await page.keyboard.press("b");
  await drag(500, 500, 600, 460);
  await page.mouse.move(600, 400, { steps: 4 });
  await page.mouse.down(); await page.mouse.up();
  const c1 = await count();

  // select it
  await page.keyboard.press("v");
  const b1 = await firstBox();
  await page.mouse.click(b1.cx, b1.cy);
  const handleCount = await page.$$eval("[data-handle]", els => els.map(e => e.dataset.handle));

  // copy → system clipboard
  await page.keyboard.down("Control"); await page.keyboard.press("c"); await page.keyboard.up("Control");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const clipOk = clip.includes('"zulfidraw":1');

  // paste (synthetic paste event, as a real Ctrl+V would deliver)
  await page.mouse.move(800, 300);
  await page.evaluate(txt => {
    const dt = new DataTransfer();
    dt.setData("text/plain", txt);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, clip);
  const c2 = await count();

  // arrow-nudge the pasted shape (it's selected): expect +2H ≈ 41.57px at 100%
  const beforeNudge = await page.evaluate(() =>
    document.querySelectorAll("#shapesLayer > g")[1].getBoundingClientRect().x);
  await page.keyboard.press("ArrowRight");
  const afterNudge = await page.evaluate(() =>
    document.querySelectorAll("#shapesLayer > g")[1].getBoundingClientRect().x);

  // cut it
  await page.keyboard.down("Control"); await page.keyboard.press("x"); await page.keyboard.up("Control");
  const c3 = await count();
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  const cUndo = await count();
  await page.keyboard.down("Control"); await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift"); await page.keyboard.up("Control");
  const cRedo = await count();

  // axis-handle stretch: select the box, drag its height handle up 2 units (48px)
  const b2 = await firstBox();
  await page.mouse.click(b2.cx, b2.cy);
  const hc = await page.evaluate(() => {
    const el = document.querySelector('[data-handle="axis:c"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const hBefore = (await firstBox()).h;
  await drag(hc.x, hc.y, hc.x, hc.y - 48);
  const hAfter = (await firstBox()).h;

  // bbox scale: single box shows axis handles only, so add a poly and select all
  await page.keyboard.press("p");
  for (const [x, y] of [[850, 500], [950, 450], [950, 550]]) await page.mouse.click(x, y);
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  const wBefore = (await firstBox()).w;
  const he = await page.evaluate(() => {
    const el = document.querySelector('[data-handle="bbox:e"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  let wAfter = null;
  if (he) { await drag(he.x, he.y, he.x + wBefore * 0.5, he.y); wAfter = (await firstBox()).w; }

  await new Promise(r => setTimeout(r, 1100)); // autosave flush
  const status = await page.$eval("#saveStatus", el => el.textContent);
  await page.screenshot({ path: path.join(SHOTS, "zulfidraw-scale.png") });

  console.log(JSON.stringify({
    afterBoxDraw: c1, handles: handleCount, clipOk,
    afterPaste: c2, nudgeDelta: +(afterNudge - beforeNudge).toFixed(2),
    afterCut: c3, afterUndo: cUndo, afterRedo: cRedo,
    heightBefore: +hBefore.toFixed(1), heightAfter: +hAfter.toFixed(1),
    widthBefore: +wBefore.toFixed(1), widthAfter: wAfter && +wAfter.toFixed(1),
    status, errors,
  }, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
