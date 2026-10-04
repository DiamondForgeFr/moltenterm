// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import * as sass from "sass";
import { describe, expect, it } from "vitest";

// Tailwind puts its utilities in a cascade layer, so any unlayered rule wins over them whatever its specificity. A
// stylesheet rule whose subject is a bare utility name (Wave's `.block` pane, #164) silently restyles every element
// that uses the utility: `<span className="block h-1.5 w-1.5 rounded-full">` became a full-size rounded square.
const TailwindUtilityNames = [
    "block",
    "inline",
    "inline-block",
    "flex",
    "inline-flex",
    "grid",
    "inline-grid",
    "hidden",
    "contents",
    "table",
    "static",
    "fixed",
    "absolute",
    "relative",
    "sticky",
    "visible",
    "invisible",
    "collapse",
    "isolate",
    "truncate",
    "grow",
    "shrink",
    "border",
    "rounded",
    "rounded-full",
    "shadow",
    "outline",
    "ring",
    "italic",
    "underline",
    "uppercase",
    "lowercase",
    "capitalize",
    "transition",
    "container",
    "sr-only",
    "select-none",
    "cursor-pointer",
];

const FrontendDir = path.resolve(__dirname, "../..");

// Wave rules that restate the utility's own declaration, so they change nothing.
const Harmless = new Set([
    "app/view/preview/csvview.scss: .csv-view .cursor-pointer",
    "app/view/preview/csvview.scss: .csv-view .select-none",
]);

// Third-party stylesheets copied as they are; their rules are scoped by the library's own root class.
const Skipped = new Set(["tailwindsetup.css", path.join("app", "view", "term", "xterm.css")]);

function stylesheets(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "node_modules") {
                found.push(...stylesheets(full));
            }
            continue;
        }
        if (/\.(s?css)$/.test(entry.name) && !entry.name.startsWith("_") && !Skipped.has(path.relative(FrontendDir, full))) {
            found.push(full);
        }
    }
    return found;
}

function compiled(file: string): string {
    if (file.endsWith(".css")) {
        return fs.readFileSync(file, "utf8");
    }
    return sass.compile(file, { loadPaths: [path.dirname(file), FrontendDir], silenceDeprecations: ["import"] }).css;
}

function insideLayer(node: postcss.Node): boolean {
    for (let parent = node.parent; parent != null; parent = parent.parent) {
        if (parent.type === "atrule" && ["layer", "keyframes"].includes((parent as postcss.AtRule).name)) {
            return true;
        }
    }
    return false;
}

// The subject is the last compound selector, e.g. `.btn:hover` in `.toolbar > .btn:hover`; pseudo-elements are
// dropped, since `.block::after` still paints on any element with the utility class.
export function subjectClass(selector: string): string {
    const compounds = selector
        .trim()
        .split(/\s*[>+~]\s*|\s+/)
        .filter((c) => c.length > 0);
    const subject = (compounds[compounds.length - 1] ?? "").replace(/::[\w-]+(\(.*\))?$/, "");
    const match = /^\.((?:\\.|[\w-])+)(?::(?:hover|focus|focus-visible|active))?$/.exec(subject);
    return match ? match[1].replace(/\\/g, "") : null;
}

export function collidingSelectors(css: string): string[] {
    const hits: string[] = [];
    postcss.parse(css).walkRules((rule) => {
        if (insideLayer(rule)) {
            return;
        }
        for (const selector of rule.selectors) {
            const name = subjectClass(selector);
            if (name != null && TailwindUtilityNames.includes(name)) {
                hits.push(selector);
            }
        }
    });
    return hits;
}

describe("collidingSelectors", () => {
    it("flags an unlayered rule styling a bare utility class", () => {
        expect(collidingSelectors(".block { width: 100%; }")).toEqual([".block"]);
        expect(collidingSelectors(".panel .hidden:hover { color: red; }")).toEqual([".panel .hidden:hover"]);
        expect(collidingSelectors(".block::after { content: ''; }")).toEqual([".block::after"]);
    });

    it("lets qualified, scoped-to-a-child or layered rules through", () => {
        expect(collidingSelectors(".block:where(.block-frame-default) { width: 100%; }")).toEqual([]);
        expect(collidingSelectors(".block.block-frame-default .block-mask { width: 100%; }")).toEqual([]);
        expect(collidingSelectors(".block-content { width: 100%; }")).toEqual([]);
        expect(collidingSelectors("@layer utilities { .block { display: block; } }")).toEqual([]);
    });
});

describe("frontend stylesheets", () => {
    it("never restyle a Tailwind utility class from outside a layer", () => {
        const offenders: string[] = [];
        for (const file of stylesheets(FrontendDir)) {
            for (const selector of collidingSelectors(compiled(file))) {
                const where = `${path.relative(FrontendDir, file)}: ${selector}`;
                if (!Harmless.has(where)) {
                    offenders.push(where);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
