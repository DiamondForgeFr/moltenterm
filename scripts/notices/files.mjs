// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The licence files of a folder (a package in node_modules, a Go module in the module cache, a font family).

import fs from "node:fs";
import path from "node:path";

// LICENSE, LICENSE.md, LICENSE-MIT, LICENCE, COPYING, UNLICENSE, NOTICE, ThirdPartyNotices.txt...
const LicenseName =
  /^(licen[cs]es?|licen[cs]ing|copying|copyright|unlicen[cs]e|notice|third[-_ ]?party[-_ ]?notices?)([-_. ][^/]*)?$/i;
// A file named like a licence that is code or data, not text.
const NotText = /\.(js|cjs|mjs|ts|cts|mts|tsx|jsx|json|map|html|css|go|py|sh|png|jpe?g|svg|woff2?|ttf)$/i;
// The folders where a package keeps its licence files when it keeps more than one.
const LicenseDirs = /^licen[cs]es?$/i;

const MaxBytes = 512 * 1024;

export function isLicenseFile(name) {
  return LicenseName.test(name) && !NotText.test(name);
}

// A text as the notices hold it: LF line ends, no byte order mark, no trailing blank lines. Two copies of one licence that
// differ by those alone are one text.
export function cleanText(text) {
  const withoutMark = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutMark
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
}

function readText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MaxBytes) {
    return null;
  }
  const text = cleanText(fs.readFileSync(file, "utf8"));
  return text === "" ? null : text;
}

// [{ file: relative path, text }], sorted by path.
export function readLicenseFiles(dir) {
  const found = [];
  const scan = (rel) => {
    const abs = path.join(dir, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = path.posix.join(rel.split(path.sep).join("/"), entry.name);
      if (entry.isFile() || entry.isSymbolicLink()) {
        if (isLicenseFile(entry.name)) {
          const text = readText(path.join(abs, entry.name));
          if (text != null) {
            found.push({ file: name, text });
          }
        }
      } else if (entry.isDirectory() && rel === "" && LicenseDirs.test(entry.name)) {
        scan(entry.name);
      }
    }
  };
  scan("");
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
