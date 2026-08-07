/* Measure the landing desktop, because "it looks empty" is not a number.
 *
 *   node scripts/measure-desktop.mjs [origin]        default http://127.0.0.1:8815
 *
 * Reports how much of the wallpaper the icons actually occupy, how much dead
 * teal sits below the lowest one, where the sticky notes start relative to the
 * fold, and the contrast of the two labels that sit directly on the teal.
 *
 * This is NOT part of `npm test`, deliberately. It needs a real browser, and
 * Playwright is not a declared dependency of this project (it is present in
 * this working copy only as an extraneous package). Putting a browser in the
 * default test path would mean every checkout downloads Chromium to run unit
 * tests, which is the kind of weight this repository exists to argue against.
 * The layout rules that produce these numbers are guarded statically instead,
 * in test/style.test.ts; this script measures whether those rules are in fact
 * producing the result they were written for.
 *
 * Run it against `npx wrangler dev --port 8815 --local`.
 */

import { chromium } from 'playwright';

const ORIGIN = process.argv[2] || 'http://127.0.0.1:8815';
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

/** WCAG 2.1 relative luminance of an "rgb(r, g, b)" string. */
function luminance(colour) {
  const [r, g, b] = colour.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio between two "rgb(...)" strings. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);           // let the power-on animation settle

const raw = await page.evaluate(() => {
  const rect = (el) => el.getBoundingClientRect();
  const desktop = document.querySelector('.desktop');
  const taskbar = document.querySelector('#page > .taskbar');
  const notes = document.querySelector('.room-footer');

  // The wallpaper is the teal a visitor sees: the top of the desktop down to
  // the top of the taskbar.
  const top = rect(desktop).top;
  const bottom = rect(taskbar).top;
  const wallpaper = { width: rect(desktop).width, height: bottom - top };

  const painted = [...document.querySelectorAll('.desk-icon, .desk-group-label')];
  const area = painted.reduce((sum, el) => {
    const r = rect(el);
    return sum + r.width * r.height;
  }, 0);

  const lowest = painted.reduce((max, el) => Math.max(max, rect(el).bottom), 0);

  const label = document.querySelector('.desk-group-label');
  const tagline = document.querySelector('#page > .tagline');
  const iconText = document.querySelector('.desk-icon span');

  return {
    wallpaper,
    iconArea: area,
    deadBelowLowestIcon: bottom - lowest,
    notesTop: notes ? rect(notes).top : null,
    documentHeight: document.documentElement.scrollHeight,
    windowsBoxHeight: rect(document.querySelector('.desk-windows')).height,
    iconCount: document.querySelectorAll('.desk-icon').length,
    iconBox: (() => { const r = rect(document.querySelector('.desk-icon')); return [Math.round(r.width), Math.round(r.height)]; })(),
    svgBox: (() => { const r = rect(document.querySelector('.desk-icon svg')); return [Math.round(r.width), Math.round(r.height)]; })(),
    colours: {
      /* The teal is painted by #page, not by .desktop, which is itself
         transparent. Asking the element the text sits in gives
         rgba(0,0,0,0) and a contrast ratio against black, which is a
         very reassuring number and a completely false one. Walk up until
         something actually paints. */
      teal: (() => {
        let el = document.querySelector('.desktop');
        while (el) {
          const bg = getComputedStyle(el).backgroundColor;
          if (bg && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
          el = el.parentElement;
        }
        return 'rgb(255, 255, 255)';
      })(),
      label: getComputedStyle(label).color,
      tagline: getComputedStyle(tagline).color,
      iconText: getComputedStyle(iconText).color,
    },
    clock: document.querySelector('.task-clock').textContent.trim(),
  };
});

await browser.close();

const fill = (raw.iconArea / (raw.wallpaper.width * raw.wallpaper.height)) * 100;
const r2 = (n) => Math.round(n * 100) / 100;

console.log(`viewport                 1440 x 900, dpr 1`);
console.log(`wallpaper                ${Math.round(raw.wallpaper.width)} x ${Math.round(raw.wallpaper.height)} = ${Math.round(raw.wallpaper.width * raw.wallpaper.height).toLocaleString()} px2`);
console.log(`icon + label area        ${Math.round(raw.iconArea).toLocaleString()} px2`);
console.log(`WALLPAPER FILL           ${r2(fill)}%`);
console.log(`dead teal below icons    ${Math.round(raw.deadBelowLowestIcon)} px`);
console.log(`.desk-windows height     ${Math.round(raw.windowsBoxHeight)} px`);
console.log(`sticky notes top         y=${Math.round(raw.notesTop)} (fold is 900)  ${raw.notesTop < 900 ? 'ABOVE FOLD' : 'below fold'}`);
console.log(`document height          ${Math.round(raw.documentHeight)} px`);
console.log(`icons                    ${raw.iconCount}, cell ${raw.iconBox.join('x')}, glyph ${raw.svgBox.join('x')}`);
console.log(`clock                    ${JSON.stringify(raw.clock)}`);
console.log(`contrast group label     ${r2(contrast(raw.colours.label, raw.colours.teal))}:1  ${contrast(raw.colours.label, raw.colours.teal) >= 4.5 ? 'AA' : 'FAILS AA'}`);
console.log(`contrast tagline         ${r2(contrast(raw.colours.tagline, raw.colours.teal))}:1  ${contrast(raw.colours.tagline, raw.colours.teal) >= 4.5 ? 'AA' : 'FAILS AA'}`);
console.log(`contrast icon label      ${r2(contrast(raw.colours.iconText, raw.colours.teal))}:1  ${contrast(raw.colours.iconText, raw.colours.teal) >= 4.5 ? 'AA' : 'FAILS AA'}`);
