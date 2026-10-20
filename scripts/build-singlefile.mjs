#!/usr/bin/env node
/**
 * Build the Vite app, then inline its hashed CSS + JS into one self-contained
 * HTML file that runs straight from disk (file://) with no server, no CDN and
 * no node_modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const source = path.join(distDir, 'index.html');
const target = path.join(root, 'island.html');

function escapeForInline(text, closingTag) {
  return text.replaceAll(closingTag, `<\\/${closingTag.slice(2)}`);
}

function assetPath(url) {
  const clean = url.replace(/^\/+/, '').replace(/^\.\//, '');
  return path.join(distDir, clean);
}

await build({ root, logLevel: 'warn' });

let html = fs.readFileSync(source, 'utf8');

// Inline every stylesheet.
const stylesheetPattern = /<link\s+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi;
for (const match of [...html.matchAll(stylesheetPattern)]) {
  const css = fs.readFileSync(assetPath(match[1]), 'utf8');
  html = html.replace(match[0], () => `<style>\n${escapeForInline(css, '</style>')}\n</style>`);
}

// Pick up the module entry, remove it from <head>, and append it at the end of
// <body> as a classic script so parsing has created the HUD DOM first. The Vite
// bundle is a single chunk with no import/export statements, so this is safe
// and avoids file:// module restrictions.
const scriptPattern = /<script\s+type="module"[^>]*src="([^"]+)"[^>]*><\/script>/i;
const scriptMatch = html.match(scriptPattern);
if (!scriptMatch) {
  throw new Error('Could not find the built module script tag in dist/index.html');
}
const script = fs.readFileSync(assetPath(scriptMatch[1]), 'utf8');
html = html.replace(scriptMatch[0], '');

html = html.replace(/\s*<link\s+rel="modulepreload"[^>]*>\s*/gi, '\n');
html = html.replace(
  '</head>',
  '  <!-- Self-contained build. Bundled three.js is MIT licensed, © three.js authors. -->\n  </head>',
);
html = html.replace(
  '</body>',
  () => `<script>\n${escapeForInline(script, '</script>')}\n</script>\n</body>`,
);

// Sanity check: a self-contained file must not reference built asset paths.
if (/(?:src|href)="\/(?:assets|src)\//.test(html) || /<link\s+rel="(?:stylesheet|modulepreload)"/i.test(html)) {
  throw new Error('Single-file build still contains external asset references');
}

fs.writeFileSync(target, html);
const size = fs.statSync(target).size;
console.log(`✔ Single-file build → ${path.relative(root, target)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
