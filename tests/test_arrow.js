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
    await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up();
  };
  const shapes = () => page.evaluate(() =>
    [...document.querySelectorAll("#shapesLayer > g")].map(g => ({
      paths: g.querySelectorAll("path").length,     // shaft + head(s) + hit path
      d: g.querySelector("path").getAttribute("d"),
    })));
  const count = async () => (await shapes()).length;
  const headsVisible = () => page.$eval("#headsRow", el => !el.classList.contains("hidden"));

  // 1. drag = straight arrow
  await page.keyboard.press("a");
  const headsShownForTool = await headsVisible();
  await drag(400, 500, 550, 420);
  const afterDrag = await shapes();

  // 2. click-click-click + Enter = elbow arrow (3 points, 2 segments)
  await page.keyboard.press("a");
  await page.mouse.click(700, 550);
  await page.mouse.click(850, 470);
  await page.mouse.click(950, 550);
  const midDraw = await count();          // ghost only — nothing committed yet
  await page.keyboard.press("Enter");
  const afterElbow = await shapes();

  // 3. right-click drops the last point mid-draw, Esc cancels entirely
  await page.keyboard.press("a");
  await page.mouse.click(300, 650);
  await page.mouse.click(400, 700);
  await page.mouse.click(500, 650);
  await page.mouse.click(500, 650, { button: "right" });
  await page.keyboard.press("Escape");
  const afterCancel = await count();

  // 4. select the straight arrow → arrowhead control appears; switch to double-headed
  await page.keyboard.press("v");
  const p0 = await page.evaluate(() => {
    const r = document.querySelectorAll("#shapesLayer > g")[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(p0.x, p0.y);
  const headsShownForSel = await headsVisible();
  const headsSynced = await page.$eval("#headBtns .swatch-active", el => el.dataset.v);
  await page.click('#headBtns [data-v="both"]');
  const afterBoth = await shapes();

  // 5. arrows behave like other shapes: nudge, dash, z-order, copy/paste
  await page.keyboard.press("ArrowRight");
  await page.click('#dashBtns [data-v="dashed"]');
  const dashedShaft = await page.$eval("#shapesLayer > g path", p => p.getAttribute("stroke-dasharray"));
  const headSolid = await page.evaluate(() => {
    const hs = document.querySelectorAll("#shapesLayer > g:first-child path");
    return hs[1].getAttribute("stroke-dasharray");   // the head must NOT be dashed
  });
  await page.keyboard.down("Control"); await page.keyboard.press("c"); await page.keyboard.up("Control");
  await page.mouse.move(650, 250);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "");
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  const afterPaste = await count();

  // 6. vertex handles on a selected elbow arrow (3 points → 3 handles)
  await page.mouse.click(10, 780);   // deselect via empty-space click
  const elbowPt = await page.evaluate(() => {
    const g = [...document.querySelectorAll("#shapesLayer > g")]
      .find(g => (g.querySelector("path").getAttribute("d").match(/L/g) || []).length >= 2);
    const r = g.getBoundingClientRect();
    return { x: r.x + 6, y: r.y + r.height - 6 };
  });
  await page.mouse.click(elbowPt.x, elbowPt.y);
  const vtxHandles = await page.$$eval('[data-handle^="vtx"]', e => e.length);

  await new Promise(r => setTimeout(r, 1100));
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  const persisted = await count();

  const svgOut = await page.evaluate(() => {
    let captured = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = b => { captured = b; return "blob:x"; };
    const oc = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById("exportBtn").click();
    URL.createObjectURL = orig; HTMLAnchorElement.prototype.click = oc;
    return captured ? captured.text() : null;
  });

  await page.screenshot({ path: path.join(SHOTS, "zulfidraw-arrows.png") });
  console.log(JSON.stringify({
    headsShownForTool,
    straightArrow: { pathsInGroup: afterDrag[0].paths, d: afterDrag[0].d },
    midDrawCommitted: midDraw,
    elbowArrow: { segments: (afterElbow[1].d.match(/L/g) || []).length, pathsInGroup: afterElbow[1].paths },
    afterRightClickAndEsc: afterCancel,
    headsShownForSel, headsSynced,
    pathsWithBothHeads: afterBoth[0].paths,
    dashedShaft, headSolid, afterPaste, vtxHandles, persisted,
    exportOk: !!svgOut && svgOut.includes("<path"),
    errors,
  }, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
