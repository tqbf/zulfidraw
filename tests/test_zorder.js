const puppeteer = require("puppeteer");
const path = require("path");

const BASE = process.env.BASE_URL || "http://localhost:8080";
const SHOTS = process.env.SHOT_DIR || require("os").tmpdir();
const { execFileSync } = require("child_process");

const DB = process.env.ZULFIDRAW_DB || path.join(__dirname, "..", "zulfidraw.db");

// run a SQL query against the app db; returns the first column of the first row
const sql = (query, ...params) => execFileSync("python3", [
  "-c",
  `import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
row = db.execute(sys.argv[2], sys.argv[3:]).fetchone()
print(row[0] if row else '')`,
  DB, query, ...params.map(String),
]).toString().trim();

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
  const did = target.split("/").pop();
  await page.goto(BASE + target, { waitUntil: "networkidle0" });

  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1); await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 }); await page.mouse.up();
  };
  // paint order = stroke color of each <g>, in DOM order
  const order = () => page.$$eval("#shapesLayer > g", els =>
    els.map(g => g.querySelector("path,text").getAttribute("stroke") || g.querySelector("text").getAttribute("fill")));

  // three overlapping filled boxes: red, blue, green (drawn in that order)
  const colors = ["#e11d48", "#2563eb", "#059669"];
  const fills = ["#fecdd3", "#bfdbfe", "#a7f3d0"];
  for (let i = 0; i < 3; i++) {
    await page.click(`#strokeSwatches [data-v="${colors[i]}"]`);
    await page.click(`#fillSwatches [data-v="${fills[i]}"]`);
    await page.keyboard.press("b");
    const x = 500 + i * 60, y = 500 - i * 30;
    await drag(x, y, x + 100, y - 40);
    await page.mouse.move(x + 100, y - 90, { steps: 4 });
    await page.mouse.down(); await page.mouse.up();
  }
  const drawn = await order();

  // click a point on the shape's left flank — the boxes step up-and-right, so
  // this strip of the target is never covered by the ones drawn after it
  const selectByColor = async c => {
    await page.keyboard.press("v");
    const pt = await page.evaluate(c => {
      const g = [...document.querySelectorAll("#shapesLayer > g")]
        .find(g => g.querySelector("path").getAttribute("stroke") === c);
      const r = g.getBoundingClientRect();
      return { x: r.x + 12, y: r.y + r.height / 2 };
    }, c);
    await page.mouse.click(pt.x, pt.y);
    const n = await page.$$eval("#overlayLayer rect[stroke-dasharray]", e => e.length);
    if (n !== 1) throw new Error(`expected 1 selected after clicking ${c}, got ${n}`);
  };

  // select the red box (currently bottom) and raise it one step
  await selectByColor("#e11d48");
  await page.click('#zBtns [data-z="raise"]');
  const afterRaise = await order();

  // bring it to front
  await page.click('#zBtns [data-z="front"]');
  const afterFront = await order();

  // keyboard: Ctrl+Shift+[ sends to back
  await page.keyboard.down("Control"); await page.keyboard.down("Shift");
  await page.keyboard.press("BracketLeft");
  await page.keyboard.up("Shift"); await page.keyboard.up("Control");
  const afterBack = await order();

  // Ctrl+] raises one
  await page.keyboard.down("Control");
  await page.keyboard.press("BracketRight");
  await page.keyboard.up("Control");
  const afterCtrlRaise = await order();

  // undo restores previous order
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  const afterUndo = await order();

  // multi-select (marquee all) → to front keeps relative order
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.click('#zBtns [data-z="front"]');
  const afterAllFront = await order();

  await new Promise(r => setTimeout(r, 1100));
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  const persisted = await order();

  // version history: snapshots recorded, and restore brings back an old doc
  const revsBefore = +sql("SELECT COUNT(*) FROM revisions WHERE drawing=?", did);
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.press("Delete");            // wipe the doc, as a runaway client would
  await new Promise(r => setTimeout(r, 1100));
  const afterWipe = await page.$$eval("#shapesLayer > g", e => e.length);
  const revId = sql("SELECT id FROM revisions WHERE drawing=? ORDER BY saved_at DESC LIMIT 1", did);
  await page.evaluate(async (did, rev) => {
    await fetch(`/d/${did}/restore/${rev}`, { method: "POST" });
  }, did, revId);
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  const afterRestore = await order();

  await page.screenshot({ path: path.join(SHOTS, "zulfidraw-zorder.png") });
  console.log(JSON.stringify({
    drawn, afterRaise, afterFront, afterBack, afterCtrlRaise, afterUndo,
    afterAllFront, persisted,
    revsBefore, afterWipe, restoredShapeCount: afterRestore.length, afterRestore,
    errors,
  }, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
