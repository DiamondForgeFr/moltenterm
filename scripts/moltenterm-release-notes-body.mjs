// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The public notes of a release as the GitHub release body carries them (FR-REL-003): the markdown of
// releases/<tag>.md after its front matter (UPSTREAM.md, "Release notes"; the Go reader is
// pkg/molten/release/notes_format.go, the app's frontend/moltenterm-shell/releases).
//
//   node scripts/moltenterm-release-notes-body.mjs releases/v1.0.0.md          prints the markdown
//   node scripts/moltenterm-release-notes-body.mjs --draft releases/v1.0.0.md  exits 0 when marked draft: true, else 1

/* global console, process */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KeyLine = /^([a-z][a-z0-9]*)\s*:\s*(.*?)\s*$/;

export function parseReleaseNotes(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(new RegExp("^" + String.fromCharCode(0xfeff)), "");
  if (!normalized.startsWith("---\n")) {
    return { front: {}, body: normalized };
  }
  const lines = normalized.slice(4).split("\n");
  const front = {};
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return {
        front,
        body: lines
          .slice(i + 1)
          .join("\n")
          .replace(/^\n+/, ""),
      };
    }
    const m = KeyLine.exec(lines[i]);
    if (m) {
      front[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { front: {}, body: normalized };
}

export function isDraft(front) {
  return ["true", "yes", "1"].includes(String(front.draft ?? "").toLowerCase());
}

function main() {
  const args = process.argv.slice(2);
  const draft = args[0] === "--draft";
  const file = draft ? args[1] : args[0];
  if (!file) {
    console.error("usage: moltenterm-release-notes-body.mjs [--draft] <releases/vX.Y.Z.md>");
    process.exit(2);
  }
  const notes = parseReleaseNotes(fs.readFileSync(file, "utf8"));
  if (draft) {
    process.exit(isDraft(notes.front) ? 0 : 1);
  }
  process.stdout.write(notes.body.trimEnd() + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
