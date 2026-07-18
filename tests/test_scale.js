const puppeteer = require("puppeteer");

const BASE = process.env.BASE_URL || "http://localhost:8080";

// font-size control and stroke-proportional arrowheads
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
  const hidden = sel => page.$eval(sel, el => el.classList.contains("hidden"));
  const lastTextSize = () => page.$eval("#shapesLayer > g:last-of-type text", t => t.getAttribute("font-size"));
  const gCenter = i => page.evaluate(i => {
    const r = document.querySelectorAll("#shapesLayer > g")[i].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);
  // for a straight arrow the group's 2nd path is the (solid) head: "M b1 L tip L b2"
  const headInfo = i => page.evaluate(i => {
    const head = document.querySelectorAll("#shapesLayer > g")[i].querySelectorAll("path")[1];
    const [b1x, b1y, tx, ty] = head.getAttribute("d").match(/-?\d+\.?\d*/g).map(Number);
    return { len: +Math.hypot(tx - b1x, ty - b1y).toFixed(2), sw: head.getAttribute("stroke-width") };
  }, i);

  // --- arrowheads scale with stroke (arrows first, so they're g0 / g1) ---
  await page.keyboard.press("a");
  await page.click('#widthBtns [data-v="3"]');            // S
  await drag(200, 600, 400, 600);
  await page.keyboard.press("a");
  await page.click('#widthBtns [data-v="9"]');            // L
  await drag(200, 680, 400, 680);
  const headS = await headInfo(0);
  const headL = await headInfo(1);

  // --- font size control ---
  await page.keyboard.press("t");
  const fontRowShownForTool = !(await hidden("#fontRow"));
  await page.mouse.click(500, 300);
  await page.keyboard.type("Hi");
  await page.keyboard.press("Enter");                     // g2, default size
  const defaultSize = await lastTextSize();

  await page.keyboard.press("t");
  await page.click('#fontBtns [data-v="128"]');           // XL
  await page.mouse.click(750, 300);
  await page.keyboard.type("Big");
  await page.keyboard.press("Enter");                     // g3, size 128
  const xlSize = await lastTextSize();

  // select the first text (g2): panel shows font size, synced to 48, then change to 80
  await page.keyboard.press("v");
  const c2 = await gCenter(2);
  await page.mouse.click(c2.x, c2.y);
  const fontRowShownForSel = !(await hidden("#fontRow"));
  const syncedActive = await page.$eval("#fontBtns .swatch-active", el => el.dataset.v);
  await page.click('#fontBtns [data-v="80"]');
  const resizedText = await page.$eval("#shapesLayer > g:nth-child(3) text", t => t.getAttribute("font-size"));

  // font-size row is text-only: hidden under the line tool
  await page.keyboard.press("l");
  const fontRowHiddenForLine = await hidden("#fontRow");

  await page.evaluate(did => fetch("/d/" + did, { method: "DELETE" }), target.split("/").pop());

  const out = {
    headS, headL, headRatio: +(headL.len / headS.len).toFixed(2),
    fontRowShownForTool, defaultSize, xlSize,
    fontRowShownForSel, syncedActive, resizedText, fontRowHiddenForLine, errors,
  };
  console.log(JSON.stringify(out, null, 2));

  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const checks = {
    "headS.sw": headS.sw === "3",
    "headL.sw": headL.sw === "9",
    "headS.len≈13.5": near(headS.len, 13.5, 0.6),      // sw(3) * HEAD_SCALE(4.5)
    "headL.len≈40.5": near(headL.len, 40.5, 0.6),      // sw(9) * HEAD_SCALE(4.5)
    "headRatio≈3": near(headL.len / headS.len, 3, 0.1),
    fontRowShownForTool,
    "defaultSize=48": defaultSize === "48",
    "xlSize=128": xlSize === "128",
    fontRowShownForSel,
    "syncedActive=48": syncedActive === "48",
    "resizedText=80": resizedText === "80",
    fontRowHiddenForLine,
    "no errors": errors.length === 0,
  };
  let fail = false;
  for (const [k, ok] of Object.entries(checks)) if (!ok) { console.error("FAIL " + k); fail = true; }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
