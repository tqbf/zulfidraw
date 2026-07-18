const puppeteer = require("puppeteer");

const BASE = process.env.BASE_URL || "http://localhost:8080";

// live dimension label: appears while dragging a shape out, reads in lattice
// units, updates with the pointer, and disappears once the shape is committed
(async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  // fresh drawing (deleted at the end) so the default view puts world (0,0)
  // at screen (640,400), making expected label values exact
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  const target = await page.evaluate(async () =>
    (await fetch("/drawings", { method: "POST" })).headers.get("hx-redirect"));
  await page.goto(BASE + target, { waitUntil: "networkidle0" });

  const H = 24 * Math.sqrt(3) / 2, V = 12;
  const label = () => page.evaluate(() => document.getElementById("dimLabel")?.textContent.trim() ?? null);
  const out = { errors };

  // line along the U axis, 4 steps: label should read "4" mid-drag
  await page.keyboard.press("l");
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(640 + 4 * H, 400 - 4 * V, { steps: 6 });
  out.lineU = await label();
  // keep dragging to 6 steps: label must track
  await page.mouse.move(640 + 6 * H, 400 - 6 * V, { steps: 4 });
  out.lineU6 = await label();
  await page.mouse.up();
  out.afterLine = await label(); // null: label gone once committed

  // vertical line, 3 steps of S=24: reads as height "3", not "3×3"
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(640, 400 - 72, { steps: 6 });
  out.lineW = await label();
  await page.mouse.up();

  // horizontal line = U−VX per 2H of screen x: 4H reads "2×2"
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(640 + 4 * H, 400, { steps: 6 });
  out.lineH = await label();
  await page.mouse.up();

  // poly: label reads the in-flight segment, from last placed point to cursor
  await page.keyboard.press("p");
  await page.mouse.click(640, 400);
  await page.mouse.move(640 + 2 * H, 400 - 2 * V, { steps: 4 });
  out.polySeg = await label();
  await page.keyboard.press("Escape");

  // box: footprint label "a×b" while dragging, "a×b×c" while setting height
  await page.keyboard.press("b");
  await page.mouse.move(500, 500);
  await page.mouse.down();
  await page.mouse.move(500 + 3 * H, 500 - 3 * V, { steps: 6 }); // pure a: 3×0
  out.boxFoot = await label();
  await page.mouse.up();
  await page.mouse.move(500 + 3 * H, 500 - 3 * V - 48, { steps: 4 }); // +2 height
  out.boxHeight = await label();
  await page.mouse.down(); await page.mouse.up(); // commit
  out.afterBox = await label();

  // resizing an existing box shows its dims too
  await page.keyboard.press("v");
  const bc = await page.evaluate(() => {
    const r = document.querySelector("#shapesLayer g:last-of-type").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(bc.x, bc.y);
  const hc = await page.evaluate(() => {
    const el = document.querySelector('[data-handle="axis:c"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (hc) {
    await page.mouse.move(hc.x, hc.y);
    await page.mouse.down();
    await page.mouse.move(hc.x, hc.y - 24, { steps: 4 });
    out.axisResize = await label();
    await page.mouse.up();
  }

  // clean up the scratch drawing
  await page.evaluate(did => fetch("/d/" + did, { method: "DELETE" }), target.split("/").pop());

  console.log(JSON.stringify(out, null, 2));
  const expect = {
    lineU: "4", lineU6: "6", afterLine: null, lineW: "3", lineH: "2×2",
    polySeg: "2", boxFoot: "3×0", afterBox: null,
  };
  let fail = errors.length > 0;
  for (const [k, v] of Object.entries(expect))
    if (out[k] !== v) { console.error(`FAIL ${k}: got ${JSON.stringify(out[k])}, want ${JSON.stringify(v)}`); fail = true; }
  if (!/^3×0×\d+$/.test(out.boxHeight || "")) { console.error(`FAIL boxHeight: ${out.boxHeight}`); fail = true; }
  if (!/^3×0×\d+$/.test(out.axisResize || "")) { console.error(`FAIL axisResize: ${out.axisResize}`); fail = true; }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
