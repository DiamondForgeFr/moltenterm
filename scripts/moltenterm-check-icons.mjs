#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Checks that every Font Awesome icon name used by the app resolves with what Moltenterm ships:
// Font Awesome Free (public/fontawesome-free/) plus the compatibility layer (public/moltenterm-icons.css).
// Wave's code targets Font Awesome Pro, so run this after every upstream merge (see UPSTREAM.md).
//
// Usage: node scripts/moltenterm-check-icons.mjs   (exit code 1 when a name does not resolve)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// Names the shipped CSS can draw.
const known = new Set();
for (const css of ["fontawesome.min.css", "brands.min.css"]) {
    for (const m of read(`public/fontawesome-free/css/${css}`).matchAll(/\.fa-([a-z0-9-]+)(?=[,{:])/g)) {
        known.add(m[1]);
    }
}
for (const m of read("public/moltenterm-icons.css").matchAll(/\.fa-([a-z0-9-]+)(?=[\s,{:.])/g)) {
    known.add(m[1]);
}

// Style and utility classes, and strings that sit next to "icon" without being icon names.
const notIcons = new Set([
    ...["solid", "regular", "light", "thin", "duotone", "sharp", "sharp-duotone", "brands", "kit", "classic"],
    ...["fw", "spin", "spin-pulse", "pulse", "beat", "fade", "beat-fade", "bounce", "flip", "shake", "border"],
    ...["lg", "sm", "xs", "2xs", "xl", "2xl", "1x", "2x", "3x", "4x", "5x", "6x", "7x", "8x", "9x", "10x"],
    ...["rotate-90", "rotate-180", "rotate-270", "rotate-by", "flip-horizontal", "flip-vertical", "flip-both"],
    ...["stack", "stack-1x", "stack-2x", "inverse", "pull-left", "pull-right", "ul", "li", "width-auto", "swap-opacity"],
]);

const sourceDirs = ["frontend", "emain", "pkg", "cmd", "index.html"];
const skipDir = /(^|\/)(node_modules|dist|preview|fontawesome-free)(\/|$)/;
const exts = new Set([".ts", ".tsx", ".scss", ".css", ".html", ".go", ".json"]);

function walk(rel, out) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || skipDir.test(rel)) return;
    if (fs.statSync(abs).isDirectory()) {
        for (const f of fs.readdirSync(abs)) walk(path.join(rel, f), out);
    } else if (exts.has(path.extname(rel)) && !/_test\.go$|\.test\.tsx?$/.test(rel)) {
        out.push(rel);
    }
}

const files = [];
for (const d of sourceDirs) walk(d, files);

const iconName = /^(?:(?:solid|regular|brands|custom)@)?([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const uses = new Map(); // name -> locations

function record(name, loc) {
    if (notIcons.has(name)) return;
    if (!uses.has(name)) uses.set(name, []);
    uses.get(name).push(loc);
}

for (const rel of files) {
    const isCode = /\.(tsx?|go)$/.test(rel);
    const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
    let inIconList = false; // inside a list declared as "...Icons = [...]" (e.g. the workspace icon palette)
    lines.forEach((line, i) => {
        const loc = `${rel}:${i + 1}`;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (inIconList) {
            if (/^\s*[}\]]/.test(line)) {
                inIconList = false;
            } else {
                for (const m of line.matchAll(/"([^"\\]{1,60})"/g)) {
                    const n = m[1].match(iconName);
                    if (n) record(n[1], loc);
                }
            }
            return;
        }
        if (isCode && /Icons\s*(?::[^=]*)?=\s*.*[[{]\s*$/.test(line)) {
            inIconList = true;
            return;
        }
        // Class tokens: "fa-name" (template placeholders such as fa-${x} are skipped).
        for (const m of line.matchAll(/(?<![A-Za-z0-9_-])fa-([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_$-])/g)) {
            if (line[m.index + m[0].length] === "$") continue;
            record(m[1], loc);
        }
        // Icon names passed as values: "name", "solid@name", "custom@name"... Only strings that are the
        // direct value of an icon property or call, or a branch of a ternary assigned to one.
        if (/icon/i.test(line) && (isCode || rel.endsWith(".json"))) {
            for (const m of line.matchAll(/"([^"\\]{1,60})"/g)) {
                const n = m[1].match(iconName);
                if (!n || m[1].startsWith("fa-")) continue;
                const before = line.slice(0, m.index).trimEnd();
                // The key must be an icon property (icon, viewIcon, "display:icon"...), not any text containing "icon".
                const iconKey = /(?:^|[^A-Za-z0-9_:./-])"?(?:[a-z]+:)?[A-Za-z]*(?:icon|Icon)"?\s*[:=]/;
                const direct = new RegExp(iconKey.source + /\s*[{(]?$/.source).test(before) || /makeIconClass\($/.test(before);
                const ternary = /[?:]$/.test(before) && iconKey.test(before) && !/[=!]==?\s*$/.test(before);
                if (direct || ternary) record(n[1], loc);
            }
        }
    });
}

const unresolved = [...uses.entries()].filter(([name]) => !known.has(name)).sort();
console.log(`icons checked: ${uses.size} names in ${files.length} files`);
if (unresolved.length === 0) {
    console.log("all icon names resolve with Font Awesome Free + public/moltenterm-icons.css");
    process.exit(0);
}
console.log(`unresolved icon names: ${unresolved.length}`);
for (const [name, locs] of unresolved) {
    console.log(`  ${name}: ${locs.slice(0, 3).join(", ")}${locs.length > 3 ? ` (+${locs.length - 3})` : ""}`);
}
process.exit(1);
