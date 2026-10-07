// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { BrowserList } from "./browser-engine";
import { BrowserAskMetaKey, browserBlockDef } from "./browser-model";
import {
    choiceBarVisible,
    choiceBrowsers,
    choiceEngineId,
    choiceOnNavigate,
    choiceSite,
    interfaceLinkTarget,
    isWebUrl,
    LinkTargetOS,
    LinkTargetPanel,
    makeEngineChoice,
} from "./link-choice";

const RepoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const Brave = { id: "brave", name: "Brave", path: "/Applications/Brave Browser.app" };
const Chrome = { id: "chrome", name: "Chrome", path: "/Applications/Google Chrome.app" };
const TwoBrowsers: BrowserList = { browsers: [Chrome, Brave], chosen: Brave, default: "" };

describe("one entry point for interface links (DS-BRW-006)", () => {
    it("keeps web pages in the panel while web:openlinksinternally is on", () => {
        expect(interfaceLinkTarget("https://github.com/a/b/actions/runs/1", true, false)).toBe(LinkTargetPanel);
        expect(interfaceLinkTarget("http://localhost:3000/", true, false)).toBe(LinkTargetPanel);
    });

    it("restores Wave's OS browser when the setting is off, unless the caller forces the panel", () => {
        expect(interfaceLinkTarget("https://github.com/", false, false)).toBe(LinkTargetOS);
        expect(interfaceLinkTarget("https://github.com/", undefined, false)).toBe(LinkTargetOS);
        expect(interfaceLinkTarget("https://github.com/", false, true)).toBe(LinkTargetPanel);
    });

    it("hands every other scheme to the OS handler", () => {
        for (const url of [
            "mailto:me@example.com",
            "vscode://file/x",
            "file:///etc/hosts",
            "about:blank",
            "nonsense",
        ]) {
            expect(interfaceLinkTarget(url, true, true)).toBe(LinkTargetOS);
        }
        expect(isWebUrl("https://")).toBe(false);
    });

    it("ships web:openlinksinternally on in MoltenTerm's default settings", () => {
        const defaults = JSON.parse(readFileSync(join(RepoRoot, "pkg/wconfig/defaultconfig/settings.json"), "utf8"));
        expect(defaults["web:openlinksinternally"]).toBe(true);
        expect(defaults["browser:default"]).toBeUndefined();
    });

    it("leaves no Moltenterm component that sends a link to the OS browser itself", () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) {
                    walk(path);
                    continue;
                }
                if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) {
                    continue;
                }
                // Comments may name these calls (browser-popup.ts explains window.open); only code counts.
                const text = readFileSync(path, "utf8")
                    .replace(/\/\*[\s\S]*?\*\//g, "")
                    .replace(/(^|\s)\/\/.*$/gm, "");
                if (/openExternal\s*\(|target=["{]["']?_blank|window\.open\s*\(/.test(text)) {
                    offenders.push(relative(RepoRoot, path).split("\\").join("/"));
                }
            }
        };
        walk(join(RepoRoot, "frontend/moltenterm-shell"));
        expect(offenders).toEqual([]);
    });
});

describe("first-link engine choice (DS-BRW-007)", () => {
    it("asks for a site without a choice while browser:default is absent", () => {
        expect(choiceSite(undefined, undefined, "https://www.github.com/a")).toBe("github.com");
        expect(choiceSite("", {}, "https://github.com/a")).toBe("github.com");
        expect(choiceSite("  ", { "example.com": "app" }, "https://github.com/a")).toBe("github.com");
    });

    it("never asks with an explicit default, app included", () => {
        expect(choiceSite("app", {}, "https://github.com/a")).toBeNull();
        expect(choiceSite("brave", {}, "https://github.com/a")).toBeNull();
    });

    it("never asks once the site, or a parent domain, has a choice", () => {
        expect(choiceSite("", { "github.com": "app" }, "https://github.com/a")).toBeNull();
        expect(choiceSite("", { "github.com": "brave" }, "https://gist.github.com/a")).toBeNull();
    });

    it("never asks for a non-web page", () => {
        expect(choiceSite("", {}, "mailto:me@example.com")).toBeNull();
    });

    it("offers the browser pages are handed off to first, then the others", () => {
        expect(choiceBrowsers(TwoBrowsers).map((b) => b.id)).toEqual(["brave", "chrome"]);
        expect(choiceBrowsers({ browsers: [Chrome], default: "" }).map((b) => b.id)).toEqual(["chrome"]);
        expect(choiceBrowsers(null)).toEqual([]);
        expect(choiceEngineId({ id: "custom", name: "Thorium", path: "/x" })).toBe("installed");
        expect(choiceEngineId(Brave)).toBe("brave");
    });

    it("remembers by default, and is dismissed by the navigation after the link's own load", () => {
        const choice = makeEngineChoice("https://github.com/a", "github.com");
        expect(choice.remember).toBe(true);
        const loaded = choiceOnNavigate(choice);
        expect(loaded).toEqual({ ...choice, loaded: true });
        expect(choiceOnNavigate(loaded)).toBeNull();
        expect(choiceOnNavigate(null)).toBeNull();
    });

    it("leaves the focus in the terminal for a page opened through BROWSER (FR-BRW-007)", () => {
        expect(makeEngineChoice("https://github.com/a", "github.com").keepFocus).toBeUndefined();
        const choice = makeEngineChoice("https://github.com/a", "github.com", true);
        expect(choice.keepFocus).toBe(true);
        expect(choiceOnNavigate(choice)).toEqual({ ...choice, loaded: true });
        expect(choiceBarVisible(choice, undefined, {}, TwoBrowsers)).toBe(true);
    });

    it("shows the bar only with an installed browser and while the site still has no choice", () => {
        const choice = makeEngineChoice("https://github.com/a", "github.com");
        expect(choiceBarVisible(choice, undefined, {}, TwoBrowsers)).toBe(true);
        expect(choiceBarVisible(choice, undefined, {}, { browsers: [], default: "" })).toBe(false);
        expect(choiceBarVisible(choice, undefined, {}, null)).toBe(false);
        expect(choiceBarVisible(choice, undefined, { "github.com": "app" }, TwoBrowsers)).toBe(false);
        expect(choiceBarVisible(choice, "app", {}, TwoBrowsers)).toBe(false);
        expect(choiceBarVisible(null, undefined, {}, TwoBrowsers)).toBe(false);
    });

    it("carries the question to a panel created for the link", () => {
        expect(browserBlockDef("https://github.com/a", null, true).meta[BrowserAskMetaKey]).toBe(true);
        expect(browserBlockDef("https://github.com/a").meta[BrowserAskMetaKey]).toBeUndefined();
    });
});
