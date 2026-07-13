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
  const click = sel => page.click(sel);
  const gAttrs = i => page.evaluate(i => {
    const g = document.querySelectorAll("#shapesLayer > g")[i];
    const path = g.querySelector("path");
    return {
      opacity: g.getAttribute("opacity"),
      dash: path.getAttribute("stroke-dasharray"),
      stroke: path.getAttribute("stroke"),
      sw: path.getAttribute("stroke-width"),
      hasCurve: /[QqCc]/.test(path.getAttribute("d")),
    };
  }, i);
  const activeOf = grp => page.evaluate(g => {
    const el = document.querySelector(g + " .swatch-active");
    return el ? el.dataset.v : null;
  }, grp);
  const opSlider = () => page.$eval("#opacity", el => el.value);

  // 1. set dashed + rounded + 50% opacity + red, then draw a box
  await click('#dashBtns [data-v="dashed"]');
  await click('#edgeBtns [data-v="1"]');
  await click('#strokeSwatches [data-v="#e11d48"]');
  await page.$eval("#opacity", el => { el.value = 50; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.keyboard.press("b");
  await drag(450, 500, 570, 450);
  await page.mouse.move(570, 380, { steps: 4 });
  await page.mouse.down(); await page.mouse.up();
  const newShape = await gAttrs(0);

  // 2. draw a second shape with sharp + solid + full opacity, black
  await click('#dashBtns [data-v="solid"]');
  await click('#edgeBtns [data-v=""]');
  await click('#strokeSwatches [data-v="#1e293b"]');
  await page.$eval("#opacity", el => { el.value = 100; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.keyboard.press("l");
  await drag(800, 500, 950, 420);
  const secondShape = await gAttrs(1);

  // 3. panel sync: select shape 0 (the red dashed rounded 50% box) → panel should follow
  await page.keyboard.press("v");
  const b0 = await page.evaluate(() => {
    const r = document.querySelectorAll("#shapesLayer > g")[0].getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  await page.mouse.click(b0.cx, b0.cy);
  const synced = {
    stroke: await activeOf("#strokeSwatches"),
    dash: await activeOf("#dashBtns"),
    round: await activeOf("#edgeBtns"),
    opacity: await opSlider(),
  };

  // 4. mutate the selected shape via the panel (dotted, width L)
  await click('#dashBtns [data-v="dotted"]');
  await click('#widthBtns [data-v="4"]');
  const mutated = await gAttrs(0);

  // 5. undo the width change, then reload and confirm persistence
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  const afterUndo = await gAttrs(0);
  await new Promise(r => setTimeout(r, 1100));
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  const persisted = await gAttrs(0);

  // 6. export SVG carries the styles
  const svgOut = await page.evaluate(() => {
    let captured = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = b => { captured = b; return "blob:fake"; };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById("exportBtn").click();
    URL.createObjectURL = origCreate;
    HTMLAnchorElement.prototype.click = origClick;
    return captured ? captured.text() : null;
  });

  await page.screenshot({ path: path.join(SHOTS, "zulfidraw-style.png") });
  console.log(JSON.stringify({
    newShape, secondShape, synced, mutated, afterUndo, persisted,
    exportHasOpacity: !!svgOut && svgOut.includes('opacity="0.5"'),
    exportHasDash: !!svgOut && svgOut.includes("stroke-dasharray"),
    exportHasCurve: !!svgOut && /Q/.test(svgOut),
    errors,
  }, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
