// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

function source(name: string): string {
    return readFileSync(new URL(name, import.meta.url), "utf8");
}

function cssRule(css: string, selector: string): string {
    const start = css.indexOf("\n" + selector + " {");
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
}

// The test environment has no DOM to compute styles, so the guard reads the rules and the classes the tab renders.
describe("tab bar cursor (#1178)", () => {
    const css = source("./tab-bar.css");
    const tab = source("../app/tab/tab.tsx");

    it("shows a pointer over a tab, active or not", () => {
        expect(cssRule(css, ".tab.molten-tab")).toContain("cursor: pointer;");
        expect(tab).toContain('"molten-tab": true');
    });

    it("shows the text cursor over the name being renamed", () => {
        expect(cssRule(css, ".tab.molten-tab .name.focused")).toContain("cursor: text;");
        expect(tab).toContain('className={clsx("name", { focused: isEditable })}');
        expect(tab).toContain("contentEditable={isEditable}");
    });
});
