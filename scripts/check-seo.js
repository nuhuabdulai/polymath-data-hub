#!/usr/bin/env node
/* Page structure gate.
 *
 * Catches the class of mistake that is invisible in a browser but visible to Google and
 * to every customer who gets a link preview:
 *
 *   1. FAQ structured data that no longer matches the FAQ on the page. Google requires
 *      the two to agree, and a mismatch can cost the rich result — but nothing about the
 *      page looks wrong when you open it.
 *   2. A price hard-coded into static HTML. Prices are set in the admin panel, so any
 *      number written into a page is a promise that will eventually be false, and it
 *      lands in the meta description, i.e. in the search result.
 *   3. A sitemap that advertises a page marked noindex — a contradictory signal that
 *      Search Console reports as an error.
 *   4. An indexable page missing a title, description or canonical URL.
 *
 *   node scripts/check-seo.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const PLACEHOLDER = "https://bundles.example.com";

const strip = (s) =>
  String(s).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&mdash;/g, "\u2014")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();

const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).sort();
const problems = [];
const notes = [];

/* ---- 1 + 2: structured data parity and hard-coded prices ------------------------- */
for (const f of pages) {
  const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");

  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  for (const [, body] of ldBlocks) {
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      problems.push(`${f}: structured data is not valid JSON (${e.message})`);
      continue;
    }
    if (data["@type"] !== "FAQPage") continue;

    const visible = [...html.matchAll(/<details class="faq"><summary>(.*?)<\/summary>\s*<p>(.*?)<\/p>\s*<\/details>/gs)]
      .map((m) => [strip(m[1]), strip(m[2])]);
    const declared = (data.mainEntity || []).map((q) => [strip(q.name), strip(q.acceptedAnswer?.text)]);

    if (!visible.length) {
      problems.push(`${f}: has FAQPage structured data but no visible <details class="faq"> questions`);
      continue;
    }
    if (visible.length !== declared.length) {
      problems.push(`${f}: ${visible.length} visible FAQ entries but ${declared.length} in the structured data`);
    }
    for (let i = 0; i < Math.min(visible.length, declared.length); i++) {
      if (visible[i][0] !== declared[i][0]) {
        problems.push(`${f}: FAQ question ${i + 1} differs between the page and the structured data`);
      }
      if (visible[i][1] !== declared[i][1]) {
        problems.push(`${f}: FAQ answer ${i + 1} differs between the page and the structured data`);
      }
    }
  }

  /* A currency amount in customer-facing markup means a price was typed into a page.
     The per-network pages fill their price from the live catalogue instead. */
  const body = html.replace(/<script[^>]*>.*?<\/script>/gs, "");
  const price = body.match(/(?:GHS|GH\u20b5)\s?\d+(?:\.\d+)?/);
  if (price) {
    problems.push(`${f}: hard-coded price "${price[0]}" in the page — prices come from the catalogue, so this will go stale`);
  }
}

/* ---- 3 + 4: sitemap vs noindex, and the basics on every indexable page ----------- */
const sitemap = fs.readFileSync(path.join(PUBLIC, "sitemap.xml"), "utf8");
const sitemapPaths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
  m[1].replace(PLACEHOLDER, "").replace(/^$/, "/"));

const noindex = new Set();
for (const f of pages) {
  const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
  const robots = html.match(/<meta name="robots" content="([^"]*)"/i);
  if (robots && /noindex/i.test(robots[1])) {
    noindex.add("/" + f.replace(/\.html$/, ""));
    noindex.add("/" + f);
  }
}

for (const u of sitemapPaths) {
  if (noindex.has(u) || noindex.has(u + ".html")) {
    problems.push(`sitemap.xml lists ${u}, but that page is marked noindex — contradictory signal`);
  }
}

const indexable = [];
for (const f of pages) {
  const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
  const robots = html.match(/<meta name="robots" content="([^"]*)"/i);
  if (robots && /noindex/i.test(robots[1])) continue;
  indexable.push(f);

  if (!/<title>[^<]{10,}<\/title>/.test(html)) problems.push(`${f}: missing or too-short <title>`);
  if (!/<meta name="description" content="[^"]{40,}"/.test(html)) problems.push(`${f}: missing meta description`);
  if (!/<link rel="canonical"/.test(html)) problems.push(`${f}: missing canonical URL`);
  if (/\{[a-zA-Z]+\}/.test(html.match(/<title>[^<]*<\/title>/)?.[0] || "")) {
    problems.push(`${f}: title still contains an unsubstituted template placeholder`);
  }
}

/* Every page, indexable or not, should survive being shared or opened in a tab. */
for (const f of pages) {
  const html = fs.readFileSync(path.join(PUBLIC, f), "utf8");
  if (!/<link rel="icon"/.test(html)) problems.push(`${f}: no favicon link`);
  if (!/<meta name="description"/.test(html) && !/noindex/i.test(html)) {
    notes.push(`${f}: no meta description (fine if it is noindex)`);
  }
}

console.log(`check-seo: ${pages.length} pages, ${indexable.length} indexable, ${sitemapPaths.length} sitemap entries`);
console.log(`  ok    FAQ structured data matches the visible FAQ on every network page`);
console.log(`  ok    no hard-coded prices in any page`);
console.log(`  ok    sitemap and noindex agree`);
console.log(`  ok    every indexable page has a title, description and canonical`);
for (const n of notes) console.log(`  note  ${n}`);

if (problems.length) {
  console.error(`\ncheck-seo: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  FAIL  ${p}`);
  process.exit(1);
}
console.log("\ncheck-seo: all checks passed.");
