// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("./moltenterm-external-links", () => ({ openExternalLink: vi.fn() }));

import { isDevServerReload } from "./emain-util";

describe("isDevServerReload (#1238)", () => {
    it("takes a reload of index.html at the dev server's address, whatever its port", () => {
        expect(isDevServerReload("http://localhost:5175/index.html", "http://localhost:5175")).toBe(true);
        expect(isDevServerReload("http://localhost:5175/index.html?x=1", "http://localhost:5175/")).toBe(true);
    });

    it("leaves every other address to the external-link rule", () => {
        expect(isDevServerReload("http://localhost:5176/index.html", "http://localhost:5175")).toBe(false);
        expect(isDevServerReload("http://localhost:5175/other.html", "http://localhost:5175")).toBe(false);
        expect(isDevServerReload("https://github.com/index.html", "http://localhost:5175")).toBe(false);
        expect(isDevServerReload("http://localhost:5175/index.html", undefined)).toBe(false);
        expect(isDevServerReload("not a url", "http://localhost:5175")).toBe(false);
    });
});
