// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Size of the built renderer bundle (dist/frontend) and of the JavaScript every tab view loads up front: the entry
// script of index.html and its modulepreloads. Machine-independent, so CI gates it.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { round } from "./stats.mjs";

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walk(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

export function initialScripts(indexHtml) {
  const refs = [];
  for (const m of indexHtml.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) {
    refs.push(m[1]);
  }
  for (const m of indexHtml.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) {
    refs.push(m[1]);
  }
  return [...new Set(refs)];
}

const mb = (bytes) => round(bytes / 1e6, 2);

export function analyzeBundle(frontendDir) {
  const index = path.join(frontendDir, "index.html");
  if (!fs.existsSync(index)) {
    throw new Error(`${index} not found: build the frontend first (npm run build:prod)`);
  }
  const files = walk(frontendDir);
  const js = files.filter((f) => /\.m?js$/.test(f));
  const css = files.filter((f) => f.endsWith(".css"));
  let jsRaw = 0;
  let jsGzip = 0;
  const sizes = [];
  for (const f of js) {
    const buf = fs.readFileSync(f);
    const gz = zlib.gzipSync(buf, { level: 6 }).length;
    jsRaw += buf.length;
    jsGzip += gz;
    sizes.push({ file: path.relative(frontendDir, f), mb: mb(buf.length), gzipMB: mb(gz) });
  }
  const cssRaw = css.reduce((a, f) => a + fs.statSync(f).size, 0);
  const initial = initialScripts(fs.readFileSync(index, "utf8")).map((ref) => {
    const f = path.join(frontendDir, ref);
    return { file: path.relative(frontendDir, f), bytes: fs.existsSync(f) ? fs.statSync(f).size : 0 };
  });
  const initialRaw = initial.reduce((a, x) => a + x.bytes, 0);
  const totalRaw = files.filter((f) => !f.endsWith(".map")).reduce((a, f) => a + fs.statSync(f).size, 0);
  return {
    jsMB: mb(jsRaw),
    jsGzipMB: mb(jsGzip),
    jsFiles: js.length,
    cssMB: mb(cssRaw),
    initialJsMB: mb(initialRaw),
    initial: initial.map((x) => ({ file: x.file, mb: mb(x.bytes) })),
    totalWithoutMapsMB: mb(totalRaw),
    largest: sizes.sort((a, b) => b.mb - a.mb).slice(0, 10),
  };
}
