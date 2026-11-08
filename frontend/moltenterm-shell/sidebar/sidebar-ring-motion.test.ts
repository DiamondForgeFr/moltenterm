// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace dot's ring pulse (sidebar.css .mt-sb-dot.has-ring::after) stops under the system's reduced-motion
// setting and under the app's own .prefers-reduced-motion class, the MoltenTerm setting (#1946).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");

describe("workspace dot ring under reduced motion (#1946)", () => {
    it("holds the ring still under the app's .prefers-reduced-motion class", () => {
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-sb-dot\.has-ring::after \{\s*animation: none;\s*\}/);
    });

    it("keeps the system's prefers-reduced-motion media query for the same ring", () => {
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-sb-dot\.has-ring::after \{\s*animation: none;/);
    });
});
