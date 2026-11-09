// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The third-party files the repository itself carries and the app ships (#2126): the fonts and icon sets of public/, and
// a script embedded in wavesrv. They are not in any package manager, so build/moltenterm/notices/assets.json lists
// them with the text each licence requires to travel with them.

import fs from "node:fs";
import path from "node:path";
import { cleanText } from "./files.mjs";

export const AssetsFile = "build/moltenterm/notices/assets.json";

// The folder or file a component is shipped as: the first word of `shippedAs`, up to its colon.
export function shippedPath(component) {
  return component.shippedAs.split(":")[0].split(" ")[0];
}

export function collectAssets(root) {
  const problems = [];
  const listing = JSON.parse(fs.readFileSync(path.join(root, AssetsFile), "utf8"));
  const components = [];
  for (const entry of listing.components) {
    const files = [];
    for (const text of entry.texts) {
      const file = path.join(root, text.file);
      if (!fs.existsSync(file)) {
        problems.push(`${entry.name}: the licence text ${text.file} does not exist`);
        continue;
      }
      const body = cleanText(fs.readFileSync(file, "utf8"));
      files.push({ file: text.file, text: text.prefix != null ? `${text.prefix}\n\n${body}` : body });
    }
    const shipped = shippedPath(entry);
    // A pattern (fonts/name-*.woff2) stands for the files of its folder.
    const probe = shipped.includes("*") ? path.dirname(shipped) : shipped;
    if (!fs.existsSync(path.join(root, probe))) {
      problems.push(`${entry.name}: ${shipped} is not in the repository any more, remove it from ${AssetsFile}`);
    }
    components.push({
      ecosystem: "asset",
      name: entry.name,
      version: entry.version ?? "",
      declared: entry.license,
      url: entry.url,
      files,
      dirs: [shipped],
      targets: [entry.shippedAs],
    });
  }
  return { components, problems };
}
