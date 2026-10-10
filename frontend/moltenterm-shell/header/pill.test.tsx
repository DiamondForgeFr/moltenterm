// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Pill } from "./pill";

// Read from disk: vitest stubs stylesheet imports.
const headerCss = readFileSync(new URL("./header.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const shellCss = readFileSync(new URL("../moltenterm-shell.css", import.meta.url), "utf8");
const headerTsx = readFileSync(new URL("../../app/block/blockframe-header.tsx", import.meta.url), "utf8");
const termModel = readFileSync(new URL("../../app/view/term/term-model.ts", import.meta.url), "utf8");
const previewModel = readFileSync(new URL("../../app/view/preview/preview-model.tsx", import.meta.url), "utf8");

function rule(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("Pill (FR-SHELL-052, DS-SHELL-093)", () => {
    it("is 20 px high, radius 6, 11/500", () => {
        const pill = rule(headerCss, ".molten-pill");
        expect(pill).toContain("height: 20px;");
        expect(pill).toContain("border-radius: var(--mt-radius-6);");
        expect(pill).toContain("font-size: var(--mt-text-11);");
        expect(pill).toContain("font-weight: var(--mt-weight-medium);");
        expect(pill).toContain("background: var(--mt-surface-3);");
    });

    it("has the warning (amber 15 %) and danger (red 15 %, danger text) tones", () => {
        expect(rule(headerCss, ".molten-pill.is-warning")).toContain(
            "color-mix(in srgb, var(--mt-state-waiting) 15%, transparent)"
        );
        const danger = rule(headerCss, ".molten-pill.is-danger");
        expect(danger).toContain("color-mix(in srgb, var(--mt-state-error) 15%, transparent)");
        expect(danger).toContain("color: var(--mt-danger-text);");
        expect(rule(headerCss, ".molten-pill-dot")).toContain("width: 6px;");
    });

    it("renders a dot, the label and a trailing action of its own", () => {
        const html = renderToStaticMarkup(
            <Pill label="Allow npm test?" tone="warning" dot action="Go" actionLabel="Go to the terminal" title="t" />
        );
        expect(html).toContain('class="molten-pill is-warning"');
        expect(html).toContain('class="molten-pill-dot"');
        expect(html).toContain(">Allow npm test?<");
        expect(html).toMatch(
            /<button type="button" class="molten-pill-action" aria-label="Go to the terminal"[^>]*>Go</
        );
        expect(html).toContain('role="status"');
    });

    it("is a button as a whole when it only has a click, and quiet when neutral", () => {
        const html = renderToStaticMarkup(<Pill label="Durable" icon="shield" onClick={() => {}} />);
        expect(html).toMatch(/^<button type="button" class="molten-pill"/);
        expect(html).not.toContain("role=");
    });
});

describe("header hierarchy (FR-SHELL-052-AC1, AC5)", () => {
    it("draws a 28 px row, the title at 12/600 and 16 px icons", () => {
        expect(shellCss).toContain("--header-font: 600 var(--mt-text-12) / normal var(--mt-ui-font);");
        expect(shellCss).toContain("--header-height: var(--mt-row-28);");
        expect(shellCss).toContain("--header-icon-size: var(--mt-icon-16);");
        expect(rule(headerCss, ".molten-header-context")).toContain("color: var(--mt-text-muted);");
    });

    it("has no shield, connection label, tree chip or offer chip of its own any more", () => {
        for (const gone of [
            "DurableSessionFlyover",
            "ConnectionButton",
            "AgentHeaderLabel",
            "WorktreeHeaderLabel",
            "TermUpdateChip",
        ]) {
            expect(headerTsx).not.toContain(gone);
        }
        expect(headerTsx).toContain("<MoltenHeaderPill");
    });

    it("turns Wave's state labels into the Pill", () => {
        expect(termModel).not.toContain('text: "Multi Input ON"');
        expect(previewModel).not.toContain('text: "Read Only"');
        expect(previewModel).toContain('elemtype: "pill"');
    });
});

describe("working segment (FR-SHELL-052-AC4, NFR-SHELL-027)", () => {
    it("travels a quarter of the width along the bottom edge in the loop token", () => {
        const segment = rule(headerCss, ".molten-header-working");
        expect(segment).toContain("position: absolute;");
        expect(segment).toContain("height: 2px;");
        expect(segment).toContain("bottom: -1px;");
        const moving = rule(headerCss, ".molten-header-working::before");
        expect(moving).toContain("width: 25%;");
        expect(moving).toContain("animation: mt-header-working var(--mt-duration-loop) linear infinite;");
        expect(tokensCss).toContain("--mt-duration-loop: 1600ms;");
    });

    it("stands still at full width and 40 % under reduced motion, the system's and MoltenTerm's", () => {
        const media = /@media \(prefers-reduced-motion: reduce\) \{\s*\.molten-header-working::before \{([^}]*)\}/.exec(
            headerCss
        )?.[1];
        const setting = rule(headerCss, ".prefers-reduced-motion .molten-header-working::before");
        for (const body of [media, setting]) {
            expect(body).toContain("animation: none;");
            expect(body).toContain("width: 100%;");
            expect(body).toContain("opacity: 0.4;");
        }
    });

    it("never shifts the layout: the header anchors an overlay (NFR-SHELL-029)", () => {
        expect(rule(headerCss, ".block-frame-default-header")).toContain("position: relative;");
        expect(rule(headerCss, ".molten-has-proposal::after")).toContain("position: absolute;");
    });
});
