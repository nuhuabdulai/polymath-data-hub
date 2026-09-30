#!/usr/bin/env node
/* Contrast gate.
 *
 * Every colour pair below is one a customer actually reads. The values are pulled out
 * of public/css/style.css at run time, not hard-coded here, so changing a token in the
 * stylesheet fails this check instead of silently shipping 3.7:1 gray text again.
 *
 *   node scripts/check-contrast.js          # report, exit 1 on any failure
 *
 * Thresholds are WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text (>=24px, or
 * >=18.66px bold) and for focus indicators / meaningful graphics.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CSS = path.join(ROOT, "public", "css", "style.css");

function channel(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* Pull `--token: #rrggbb;` out of the stylesheet. */
function tokens(css) {
  const out = {};
  for (const line of css.split("\n")) {
    const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/);
    if (m) out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const css = fs.readFileSync(CSS, "utf8");
const t = tokens(css);

function need(name) {
  if (!t[name]) {
    console.error(`check-contrast: ${name} is not defined as a hex token in style.css`);
    process.exit(1);
  }
  return t[name];
}

/* label, foreground, background, minimum ratio */
const PAIRS = [
  ["body text (--ink on --bg)", need("--ink"), need("--bg"), 4.5],
  ["secondary text (--muted on --bg)", need("--muted"), need("--bg"), 4.5],
  ["secondary text (--muted on white cards)", need("--muted"), "#ffffff", 4.5],
  ["primary button label (white on --btn-from)", "#ffffff", need("--btn-from"), 4.5],
  ["primary button label (white on --btn-to)", "#ffffff", need("--btn-to"), 4.5],
  ["badge label (white on --brand-ink)", "#ffffff", need("--brand-ink"), 4.5],
  ["dark button label (white on --ink)", "#ffffff", need("--ink"), 4.5],
  ["WhatsApp button label (--wa-ink on --wa)", need("--wa-ink"), need("--wa"), 4.5],
  ["focus ring against white", need("--focus-ring"), "#ffffff", 3.0],
  ["focus ring against the dark footer", need("--focus-ring"), need("--ink"), 3.0],
  /* The hero gradient is background-clip:text on a 30-48px bold heading, so the large
     text threshold applies. It is the one place the decorative brand teal is allowed. */
  ["hero gradient headline, large text (--brand)", need("--brand"), need("--bg"), 3.0],
  ["hero gradient headline, large text (--brand2)", need("--brand2"), need("--bg"), 3.0],
];

let failed = 0;
for (const [label, fg, bg, min] of PAIRS) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failed++;
  console.log(`${r.toFixed(2).padStart(5)}:1  need ${min.toFixed(1)}  ${ok ? "ok  " : "FAIL"}  ${label}`);
}

/* The focus ring must also be declared, not just defined: an undefined ring means the
   browser default, which is invisible on some of these backgrounds. */
if (!/:focus-visible\s*\{[^}]*outline:\s*\d+px solid var\(--focus-ring\)/.test(css)) {
  console.log("FAIL  :focus-visible does not use a solid 3px var(--focus-ring) outline");
  failed++;
}

if (failed) {
  console.error(`\ncheck-contrast: ${failed} failure(s). Pick a darker token in style.css; do not lower a threshold.`);
  process.exit(1);
}
console.log(`\ncheck-contrast: all ${PAIRS.length} pairs pass WCAG AA.`);
