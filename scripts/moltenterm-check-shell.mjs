#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Checks that no shell script of the repository writes a variable right before a non-ASCII character ("$NAME…"):
// macOS's /bin/bash 3.2 in a UTF-8 locale reads those bytes as part of the name, so `set -u` stops on an unbound
// "NAME…" (#286). Brace the variable instead: "${NAME}…".
//
// Usage: node scripts/moltenterm-check-shell.mjs   (exit code 1 when a script has one)

/* global console, process */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const UnbracedBeforeNonAscii = /\$[A-Za-z_][A-Za-z0-9_]*[\u0080-\uffff]/;

function shellScripts() {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  return files.filter((rel) => {
    if (rel.endsWith(".sh") || rel.startsWith(".githooks/")) {
      return true;
    }
    if (!rel.startsWith("scripts/") || path.extname(rel) !== "") {
      return false;
    }
    const head = fs.readFileSync(path.join(root, rel), "utf8").slice(0, 64);
    return /^#!.*\b(ba|z)?sh\b/.test(head);
  });
}

const problems = [];
for (const rel of shellScripts()) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    continue;
  }
  fs.readFileSync(full, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (UnbracedBeforeNonAscii.test(line)) {
        problems.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
}

if (problems.length > 0) {
  console.error("A variable written right before a non-ASCII character breaks macOS's bash 3.2; brace it (${NAME}):");
  for (const p of problems) {
    console.error(`  ${p}`);
  }
  process.exit(1);
}
console.log("shell scripts: no unbraced variable before a non-ASCII character");
