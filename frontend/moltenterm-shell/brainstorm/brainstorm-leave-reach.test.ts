// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2284: Leave the brainstorm could not be clicked, only Escape got the developer out. His group's scrim is drawn after
// the brainstorm layer in the same host layer and takes the pointer while his card is open: at the same level it lay
// over the header, the switch and the widget. During the mode it goes under the layer (z-index -1 in the host's
// stacking context), and the layer, which takes no pointer itself, still lets a press on the dim reach it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const Dir = path.dirname(new URL(import.meta.url).pathname);
const BrainstormCss = readFileSync(path.join(Dir, "brainstorm.css"), "utf8");
const GroupCss = readFileSync(path.join(Dir, "../boss/brokk-group.css"), "utf8");
const Host = readFileSync(path.join(Dir, "../boss/brokk-hub-host.tsx"), "utf8");

function ruleOf(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    expect(at, `the rule ${selector}`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
}

describe("Leave the brainstorm takes the click (FR-BOSS-010 AC2a, #2284)", () => {
    it("draws the brainstorm layer before his group, in the host layer that makes the stacking context", () => {
        expect(Host.indexOf("<BrainstormLayer />")).toBeGreaterThanOrEqual(0);
        expect(Host.indexOf("<BrainstormLayer />")).toBeLessThan(Host.indexOf("<BrokkGroup"));
        expect(ruleOf(GroupCss, ".mt-boss-layer")).toMatch(/z-index:\s*\d+/);
        expect(ruleOf(GroupCss, ".mt-brokk-scrim.is-in")).toMatch(/pointer-events:\s*auto/);
    });

    it("puts his scrim under the layer while the mode is on, and the header takes the pointer", () => {
        const scrim = ruleOf(BrainstormCss, ".mt-boss-layer:has(> .mt-bs-layer.is-in) .mt-brokk-scrim");
        expect(scrim).toMatch(/z-index:\s*-1/);
        expect(ruleOf(BrainstormCss, ".mt-bs-layer")).toMatch(/pointer-events:\s*none/);
        expect(ruleOf(BrainstormCss, ".mt-bs-layer")).not.toMatch(/z-index/);
        expect(ruleOf(BrainstormCss, ".mt-bs-leave")).toMatch(/pointer-events:\s*auto/);
    });
});
