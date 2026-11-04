// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The bottom bar's workspace dots stay centred between the library and "+" (#1813), however many there are: a row of
// more than seven that fits used to start at the left (sidebar.css .mt-sb-dots.is-many).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");

function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*{([^}]*)}`));
    expect(match, selector).not.toBeNull();
    return match[2];
}

describe("the bottom bar's workspace dots (#1813)", () => {
    it("centre a short row in the space the library and + leave", () => {
        expect(src).toMatch(/"mt-sb-dots flex min-w-0 flex-1 items-center gap-0\.5"/);
        expect(src).toMatch(/many \? "is-many" : "justify-center overflow-hidden"/);
    });

    it("centre a many-dot row that fits, and keep an overflowing one scrolling from its start", () => {
        expect(rule(".mt-sb-dots.is-many")).toMatch(/overflow-x:\s*auto/);
        expect(rule(".mt-sb-dots.is-many")).not.toMatch(/justify-content:\s*(safe\s+)?center/);
        expect(rule(".mt-sb-dots.is-many > :first-child")).toMatch(/margin-left:\s*auto/);
        expect(rule(".mt-sb-dots.is-many > :last-child")).toMatch(/margin-right:\s*auto/);
    });
});
