// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isSiteListKey, siteKinds, siteRows, withoutSite, withSiteKind, withSiteValue } from "./settings-sites";

describe("per-site settings as lists (FR-SHELL-106)", () => {
    it("edits the three per-site maps of Browser as lists", () => {
        expect(isSiteListKey("browser:sites")).toBe(true);
        expect(isSiteListKey("browser:agentsites")).toBe(true);
        expect(isSiteListKey("browser:sitepermissions")).toBe(true);
        expect(isSiteListKey("browser:default")).toBe(false);
    });

    it("lists the stored sites in alphabetical order, and nothing for a value that is not a map", () => {
        expect(siteRows({ "github.com": "app", "docs.rs": "installed" })).toEqual([
            { site: "docs.rs", value: "installed" },
            { site: "github.com", value: "app" },
        ]);
        expect(siteRows(null)).toEqual([]);
        expect(siteRows(["github.com"])).toEqual([]);
        expect(siteRows("github.com")).toEqual([]);
    });

    it("changes a stored site's choice and never adds a site", () => {
        const map = { "github.com": "allow" };
        expect(withSiteValue(map, "github.com", "block")).toEqual({ "github.com": "block" });
        expect(withSiteValue(map, "gitlab.com", "block")).toBe(map);
        expect(map).toEqual({ "github.com": "allow" });
    });

    it("removes a site, and clears the key once the list is empty", () => {
        const map = { "github.com": "allow", "docs.rs": "block" };
        expect(withoutSite(map, "github.com")).toEqual({ "docs.rs": "block" });
        expect(withoutSite({ "github.com": "allow" }, "github.com")).toBeNull();
        expect(withoutSite(null, "github.com")).toBeNull();
    });

    it("changes or forgets one answer of a site, and removes the site with its last answer", () => {
        const store = { "meet.example.com": { camera: "allow", microphone: "block" } };
        expect(siteKinds(store["meet.example.com"])).toEqual(["camera", "microphone"]);
        expect(withSiteKind(store, "meet.example.com", "microphone", "allow")).toEqual({
            "meet.example.com": { camera: "allow", microphone: "allow" },
        });
        expect(withSiteKind(store, "meet.example.com", "camera", null)).toEqual({
            "meet.example.com": { microphone: "block" },
        });
        expect(withSiteKind({ "a.test": { camera: "allow" } }, "a.test", "camera", null)).toBeNull();
        expect(withSiteKind(store, "other.test", "camera", "allow")).toBe(store);
    });
});
