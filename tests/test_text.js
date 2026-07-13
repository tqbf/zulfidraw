const puppeteer = require("puppeteer");
const path = require("path");

const BASE = process.env.BASE_URL || "http://localhost:8080";
const SHOTS = process.env.SHOT_DIR || require("os").tmpdir();

(async () => {
  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.waitForSelector("#shapesLayer");

  const active = () => page.evaluate(() =>
    document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className.slice(0, 20) : "none");
  const count = () => page.$$eval("#shapesLayer > g", els => els.length);

  await page.keyboard.press("t");
  await page.mouse.click(400, 400);
  console.log("right after click, activeElement:", await active());
  await new Promise(r => setTimeout(r, 100));
  console.log("after 100ms, activeElement:", await active());

  await page.keyboard.type("abc");
  console.log("input value:", await page.evaluate(() => {
    const i = document.querySelector("input.absolute");
    return i ? JSON.stringify(i.value) : "NO INPUT";
  }));
  const before = await count();
  await page.keyboard.press("Enter");
  await new Promise(r => setTimeout(r, 100));
  console.log("shapes before Enter:", before, "after Enter:", await count());
  console.log("activeElement now:", await active());

  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await new Promise(r => setTimeout(r, 100));
  console.log("after ctrl+z:", await count());
  await browser.close();
})();
