// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { formatFinding, lintCss, lintFile, lintTs, OwnedFrontendDirs } from "./token-lint";

const FrontendDir = resolve(__dirname, "../..");

// The lint's own sources and the radius cap spell the literals they look for.
const Skipped = new Set([
    join("moltenterm-shell", "build", "token-lint.ts"),
    join("moltenterm-shell", "build", "cap-radius.ts"),
]);

function ownedFiles(): string[] {
    const files: string[] = [];
    for (const dir of OwnedFrontendDirs) {
        for (const rel of readdirSync(join(FrontendDir, dir), { recursive: true }) as string[]) {
            const file = join(dir, rel);
            if (!/\.(tsx?|css)$/.test(file) || /\.test\.tsx?$/.test(file) || /\.d\.ts$/.test(file) || Skipped.has(file)) {
                continue;
            }
            files.push(file);
        }
    }
    return files;
}

describe("design tokens lint (FR-SHELL-044 AC1, TC-SHELL-093)", () => {
    it("finds MoltenTerm's CSS and TSX", () => {
        const files = ownedFiles();
        expect(files).toContain(join("moltenterm-shell", "moltenterm-shell.css"));
        expect(files).toContain(join("moltenterm-shell", "workspace-rail.tsx"));
        expect(files.some((f) => f.startsWith("moltenterm-onboarding"))).toBe(true);
    });

    it("passes on every MoltenTerm-owned file", () => {
        const findings = ownedFiles().flatMap((file) => lintFile(file, readFileSync(join(FrontendDir, file), "utf8")));
        expect(findings.map(formatFinding)).toEqual([]);
    });

    it("fails on an off-scale font size in CSS, naming the file and the literal", () => {
        const css = ".molten-x {\n    color: red;\n    font-size: 10px;\n}\n";
        const findings = lintCss("moltenterm-shell/x.css", css);
        expect(findings.map(formatFinding)).toEqual([
            "moltenterm-shell/x.css:3: font-size: 10px (font size off the type scale)",
        ]);
    });

    it.each([
        ["font-size: var(--mt-text-12);", 0],
        ["font-size: var(--mt-icon-14);", 0],
        ["font-size: 12px;", 1],
        ["font: 12px/1.35 sans-serif;", 1],
        ["font-weight: 600;", 0],
        ["font-weight: 700;", 1],
        ["font-weight: bold;", 1],
        ["border-radius: var(--mt-radius-panel);", 0],
        ["border-radius: 0 var(--mt-radius-control) var(--mt-radius-control) 0;", 0],
        ["border-radius: var(--block-border-radius, var(--mt-radius-panel));", 0],
        ["border-radius: var(--df-radius-md);", 0],
        ["border-radius: 9999px;", 0],
        ["border-radius: 50%;", 0],
        ["border-radius: calc(var(--block-border-radius) - 1px);", 1],
        ["border-radius: 5px;", 1],
        ["border-radius: 4px;", 1],
        ["border-radius: var(--mt-radius-3);", 1],
        ["border-radius: var(--mt-radius-10);", 1],
        ["border-top-left-radius: var(--my-radius);", 1],
        ["transition: opacity var(--mt-duration-fast) var(--mt-ease);", 0],
        ["transition: opacity var(--mt-duration-fast) var(--mt-ease) calc(140ms + 70ms * var(--i));", 0],
        ["transition: none;", 0],
        ["transition: opacity 150ms ease-out;", 1],
        ["transition: opacity var(--mt-duration-base) var(--mt-ease), width 0.6s ease;", 1],
        ["transition-duration: 200ms;", 1],
        ["--mt-text-12: 12px;", 0],
        ["font-size: var(--df-text-chip);", 0],
        ["font-size: var(--df-chip-height);", 1],
        ["font-weight: var(--df-weight-semibold);", 0],
        ["transition: opacity var(--df-duration-fade) ease;", 0],
    ])("CSS %s → %i finding(s)", (decl, count) => {
        expect(lintCss("x.css", `.a { ${decl} }`)).toHaveLength(count);
    });

    it.each([
        ['<div className="text-12 font-semibold rounded-6" />', 0],
        ['<i className="fa fa-solid text-icon-14" />', 0],
        ['<div className="rounded-full rounded-t-4 rounded-none" />', 0],
        ['<div className="text-[10px]" />', 1],
        ['<div className="text-xs" />', 1],
        ['<div className="hover:text-sm" />', 1],
        ['<div className="font-bold" />', 1],
        ['<div className="font-[700]" />', 1],
        ['<div className="font-[600]" />', 0],
        ['<div className="rounded" />', 1],
        ['<div className="rounded-md" />', 1],
        ['<div className="rounded-[10px]" />', 1],
        ['<div className="rounded-l" />', 1],
        ['<div className="rounded-4 rounded-l-6 hover:rounded-t-4" />', 0],
        ['<div className="rounded-3" />', 1],
        ['<div className="rounded-2" />', 1],
        ['<div className="rounded-8" />', 1],
        ['<div className="rounded-10" />', 1],
        ['<div className="rounded-l-3" />', 1],
        ['<div className="md:rounded-12" />', 1],
        ['<div className="transition-colors duration-120 ease-mt hover:bg-hover" />', 0],
        ['<div className="transition-colors hover:bg-hover" />', 1],
        ['<div className="transition-opacity duration-150 ease-mt" />', 2],
        ['<div className="transition-none ease-out" />', 1],
        ["<div style={{ fontSize: 10 }} />", 1],
        ['<div style={{ borderRadius: "8px" }} />', 1],
        ["<div style={{ fontWeight: 600 }} />", 0],
        ["// a rounded corner, text-xs in a comment\nconst x = 1;", 0],
        ['const url = "https://example.com"; // rounded', 0],
    ])("TSX %s → %i finding(s)", (src, count) => {
        expect(lintTs("x.tsx", src)).toHaveLength(count);
    });

    it.each([
        [":root { --mt-x: #ff7c0d; }", 0],
        [":where(:root) { --df-x: #ffffff; }", 0],
        ["@media (prefers-reduced-motion: reduce) { :root { --mt-x: #000; } }", 0],
        [".a { --mt-x: #ff7c0d; }", 1],
        [".a { color: #eee; }", 1],
        [".a { color: var(--mt-text-1, #f7f7f7); }", 1],
        [".a { border: 1px solid #333336; }", 1],
        [".a { background: linear-gradient(#fff, #000a); }", 2],
        [".a { color: var(--mt-text-1); background: rgb(0 0 0 / 0.5); }", 0],
        [".a { mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); }", 0],
        [".a { -webkit-mask: linear-gradient(90deg, transparent, #000 14px); }", 0],
        ["/* #1339 and #fff in a comment */ .a { color: red; }", 0],
    ])("CSS colour %s → %i finding(s) (FR-SHELL-119)", (src, count) => {
        expect(lintCss("x.css", src).filter((f) => f.rule.startsWith("hard-coded colour"))).toHaveLength(count);
    });

    it.each([
        ['<div className="text-[#e5e7eb]" />', 1],
        ['<div className="bg-[#333]" />', 1],
        ['const c = "#ff7c0d";', 1],
        ['const c = "#000000";', 1],
        ['<div style={{ background: "conic-gradient(#ff453a, #ffe900)" }} />', 2],
        ['const s = `.x { fill: #82a9ee; }`;', 1],
        ['console.log("[#490] could not read", e);', 0],
        ['const s = "rebase of #1107";', 0],
        ["// a #fff comment\nconst x = 1;", 0],
        ['<div className="text-[var(--mt-chart-1)]" />', 0],
    ])("TSX colour %s → %i finding(s) (FR-SHELL-119)", (src, count) => {
        expect(lintTs("moltenterm-shell/x.tsx", src).filter((f) => f.rule.startsWith("hard-coded colour"))).toHaveLength(count);
    });

    it("lets the listed colour data files hold their hex values", () => {
        expect(lintTs("moltenterm-shell/workspace-colour.ts", 'const c = "#ff453a";')).toEqual([]);
        expect(lintTs("moltenterm-shell/other.ts", 'const c = "#ff453a";')).toHaveLength(1);
    });

    it("names the file, the line and the hex of a colour finding", () => {
        const css = ".a {\n    color: var(--mt-text-1);\n    border-color: #9a3412;\n}\n";
        expect(lintCss("moltenterm-shell/x.css", css).map(formatFinding)).toEqual([
            "moltenterm-shell/x.css:3: border-color: #9a3412 (hard-coded colour (use a token))",
        ]);
    });

    it("names the line of a TSX finding", () => {
        const findings = lintTs("moltenterm-shell/y.tsx", 'const a = 1;\nconst b = "flex text-[9px]";\n');
        expect(findings.map(formatFinding)).toEqual(["moltenterm-shell/y.tsx:2: text-[9px] (font size off the type scale)"]);
    });
});
