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
  const url = page.url();
  await page.waitForSelector("#shapesLayer");
  const before = await page.$$eval("#shapesLayer > g", els => els.length);

  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 });
    await page.mouse.up();
  };

  // line tool
  await page.keyboard.press("l");
  await drag(600, 400, 730, 330);

  // box tool: footprint drag, then height click
  await page.keyboard.press("b");
  await drag(500, 550, 620, 500);
  await page.mouse.move(620, 400, { steps: 5 });
  await page.mouse.down(); await page.mouse.up();

  // polygon: click 3 points then Enter
  await page.keyboard.press("p");
  for (const [x, y] of [[850, 500], [950, 450], [950, 550]]) {
    await page.mouse.click(x, y);
  }
  await page.keyboard.press("Enter");

  // text tool
  await page.keyboard.press("t");
  await page.mouse.click(600, 620);
  await page.waitForSelector("input.absolute");
  await page.keyboard.type("hello iso");
  await page.keyboard.press("Enter");
  await page.waitForSelector("input.absolute", { hidden: true });

  await new Promise(r => setTimeout(r, 1200)); // let autosave flush
  const after = await page.$$eval("#shapesLayer > g", els => els.length);
  const status = await page.$eval("#saveStatus", el => el.textContent);
  const boxPaths = await page.$$eval("#shapesLayer > g:nth-child(" + (before + 2) + ") path", els => els.length);

  // undo removes the text
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  const afterUndo = await page.$$eval("#shapesLayer > g", els => els.length);

  // reload → shapes persisted?
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  const persisted = await page.$$eval("#shapesLayer > g", els => els.length);

  await page.screenshot({ path: path.join(SHOTS, "zulfidraw.png") });

  console.log(JSON.stringify({
    url, before, after, afterUndo, persisted, status,
    boxPaths, errors,
  }, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
