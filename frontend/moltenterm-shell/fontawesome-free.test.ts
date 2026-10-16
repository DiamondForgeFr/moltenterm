// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CssDir = path.resolve(__dirname, "../../public/fontawesome-free/css");

// html-to-image (the tile drag preview) fetches every url() of every @font-face, not only the one the
// browser picked, so a fallback that does not ship logs ERR_FILE_NOT_FOUND on each panel (#752).
// Font Awesome's upstream CSS lists .ttf fallbacks: strip them again when updating it.
describe("vendored Font Awesome CSS", () => {
    const cssFiles = fs.readdirSync(CssDir).filter((name) => name.endsWith(".css"));

    it("has stylesheets to check", () => {
        expect(cssFiles.length).toBeGreaterThan(0);
    });

    it.each(cssFiles)("%s only references shipped files", (name) => {
        const css = fs.readFileSync(path.join(CssDir, name), "utf8");
        const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
        const missing = urls.filter((url) => !fs.existsSync(path.resolve(CssDir, url)));
        expect(missing).toEqual([]);
    });
});
