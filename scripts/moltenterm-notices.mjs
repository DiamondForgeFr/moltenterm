#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Third-party licence notices (#2126). Collects what really ships, finds each part's licence, and either writes
// dist/licenses/THIRD-PARTY-NOTICES.txt (the packaged app carries it) or only checks the licences (CI).
//
//   npm      the packages the bundler's module graph lists for Electron main, the preload and the renderer, written by the
//            build (frontend/moltenterm-shell/build/bundled-packages.ts); needs `npm run build:prod` first
//   go       the modules `go list -deps` finds in wavesrv, wsh and molten, from the module cache (`go mod download`)
//   assets   the fonts and icon sets of public/ and the other files listed in build/moltenterm/notices/assets.json
//
// A licence that is unknown, or not on the allow-list of build/moltenterm/license-policy.json (and not a reviewed
// exception there), fails the run: nothing is written, the exit code is 1.
//
// Usage:
//   node scripts/moltenterm-notices.mjs                          write the notices file from every source
//   node scripts/moltenterm-notices.mjs --check [--sources npm,assets]   check the licences, write nothing
//   node scripts/moltenterm-notices.mjs --out <file>             write elsewhere than dist/licenses/
//   node scripts/moltenterm-notices.mjs --root <dir>             read another repository (the tests do)

/* global console, process */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNotices, NoticesFile, Sources } from "./notices/notices.mjs";

const DefaultRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { check: false, sources: Sources, out: null, partial: false, root: DefaultRoot };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--sources") {
      options.sources = (argv[++i] ?? "").split(",").filter((s) => s !== "");
      options.partial = true;
    } else if (arg === "--out") {
      options.out = path.resolve(argv[++i] ?? "");
    } else if (arg === "--root") {
      options.root = path.resolve(argv[++i] ?? "");
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  const unknown = options.sources.filter((source) => !Sources.includes(source));
  if (unknown.length > 0 || options.sources.length === 0) {
    throw new Error(`--sources takes ${Sources.join(", ")} (got ${unknown.join(", ") || "nothing"})`);
  }
  // The file the package ships is written from every source; a subset goes to a file named with --out.
  if (options.partial && !options.check && options.out == null) {
    throw new Error("--sources only applies with --check or --out: the shipped notices file holds every source");
  }
  options.out ??= path.join(options.root, NoticesFile);
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const result = buildNotices(options.root, { sources: options.sources });
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  for (const entry of result.stale) {
    console.warn(`warning: the exception for ${entry.ecosystem} ${entry.name} matches nothing that ships, remove it`);
  }
  if (result.problems.length > 0) {
    console.error(`${result.problems.length} problem(s) with the third-party licences:`);
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      "A licence that is not on the allow-list is reviewed, then added to build/moltenterm/license-policy.json " +
        "(an exception, with its reason)."
    );
    process.exit(1);
  }
  const summary = `${result.entries.length} components (${options.sources.join(", ")})`;
  if (options.check) {
    console.log(`third-party licences: ${summary}, all allowed`);
    return;
  }
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, result.text);
  console.log(
    `third-party notices: ${summary} -> ${path.relative(options.root, options.out)} (${result.text.length} bytes)`
  );
}

main();
