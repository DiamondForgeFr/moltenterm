// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { setKeyUtilPlatform } from "@/util/keyutil";
import { afterEach, describe, expect, it } from "vitest";
import { findShortcut } from "../shortcuts/registry";
import {
    blockIdOfPage,
    browserKeyAction,
    BrowserKeyAddress,
    BrowserKeyBack,
    BrowserKeyFind,
    BrowserKeyForward,
    BrowserKeyHardReload,
    BrowserKeyReload,
    BrowserKeyStop,
    BrowserKeyZoomIn,
    BrowserKeyZoomOut,
    BrowserKeyZoomReset,
    browserPageKeys,
    nextZoomStep,
    routeBrowserPageKey,
} from "./browser-keys";

type Mods = { meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean };

// A keydown as emain's adaptFromElectronKeyEvent builds it: Wave's cmd is Meta on macOS and Alt elsewhere.
function key(k: string, mods: Mods, mac: boolean): WaveKeyboardEvent {
    return {
        type: "keydown",
        key: k,
        code: "",
        shift: !!mods.shift,
        control: !!mods.control,
        alt: !!mods.alt,
        meta: !!mods.meta,
        cmd: mac ? !!mods.meta : !!mods.alt,
        option: mac ? !!mods.alt : !!mods.meta,
    } as WaveKeyboardEvent;
}

afterEach(() => setKeyUtilPlatform("darwin"));

describe("browser panel keys on macOS (#1722)", () => {
    const mac = true;
    it("maps the usual browser keys", () => {
        setKeyUtilPlatform("darwin");
        const cases: [string, Mods, string][] = [
            ["r", { meta: true }, BrowserKeyReload],
            ["F5", {}, BrowserKeyReload],
            ["R", { meta: true, shift: true }, BrowserKeyHardReload],
            ["F5", { shift: true }, BrowserKeyHardReload],
            ["[", { meta: true }, BrowserKeyBack],
            ["ArrowLeft", { meta: true }, BrowserKeyBack],
            ["]", { meta: true }, BrowserKeyForward],
            ["ArrowRight", { meta: true }, BrowserKeyForward],
            ["f", { meta: true }, BrowserKeyFind],
            ["=", { meta: true }, BrowserKeyZoomIn],
            ["+", { meta: true, shift: true }, BrowserKeyZoomIn],
            ["-", { meta: true }, BrowserKeyZoomOut],
            ["0", { meta: true }, BrowserKeyZoomReset],
            ["l", { meta: true }, BrowserKeyAddress],
            ["Escape", {}, BrowserKeyStop],
        ];
        for (const [k, mods, action] of cases) {
            expect([k, mods, browserKeyAction(key(k, mods, mac), mac)]).toEqual([k, mods, action]);
        }
    });

    it("leaves Ctrl+R, plain letters and key-ups alone", () => {
        setKeyUtilPlatform("darwin");
        expect(browserKeyAction(key("r", { control: true }, mac), mac)).toBeNull();
        expect(browserKeyAction(key("r", {}, mac), mac)).toBeNull();
        expect(browserKeyAction({ ...key("r", { meta: true }, mac), type: "keyup" }, mac)).toBeNull();
    });
});

describe("browser panel keys on Windows and Linux (#1722)", () => {
    const mac = false;
    it("maps Ctrl, F5 and Alt with the arrows", () => {
        setKeyUtilPlatform("linux");
        const cases: [string, Mods, string][] = [
            ["r", { control: true }, BrowserKeyReload],
            ["F5", {}, BrowserKeyReload],
            ["R", { control: true, shift: true }, BrowserKeyHardReload],
            ["F5", { control: true }, BrowserKeyHardReload],
            ["ArrowLeft", { alt: true }, BrowserKeyBack],
            ["ArrowRight", { alt: true }, BrowserKeyForward],
            ["f", { control: true }, BrowserKeyFind],
            ["=", { control: true }, BrowserKeyZoomIn],
            ["-", { control: true }, BrowserKeyZoomOut],
            ["0", { control: true }, BrowserKeyZoomReset],
            ["l", { control: true }, BrowserKeyAddress],
        ];
        for (const [k, mods, action] of cases) {
            expect([k, mods, browserKeyAction(key(k, mods, mac), mac)]).toEqual([k, mods, action]);
        }
    });

    it("does not take Alt+R, Wave's Cmd+R there", () => {
        setKeyUtilPlatform("linux");
        expect(browserKeyAction(key("r", { alt: true }, mac), mac)).toBeNull();
    });
});

describe("the keys held back from a page", () => {
    it("lists every key of the table for the platform", () => {
        expect(browserPageKeys(true)).toEqual(expect.arrayContaining(["Cmd:r", "Cmd:[", "Cmd:0", "F5", "Escape"]));
        expect(browserPageKeys(false)).toEqual(expect.arrayContaining(["Ctrl:r", "Alt:ArrowLeft", "Ctrl:l", "F5"]));
        expect(browserPageKeys(false)).not.toContain("Cmd:r");
    });

    it("matches the shortcuts sheet", () => {
        for (const id of ["reload", "hard-reload", "back", "forward", "find", "zoom-in", "zoom-out", "zoom-reset"]) {
            const mac = findShortcut(`browser-${id}`);
            const other = findShortcut(`browser-${id}-other`);
            expect(mac.macOnly).toBe(true);
            expect(other.notMac).toBe(true);
            for (const k of [mac.keys, ...(mac.alt ?? [])]) expect(browserPageKeys(true)).toContain(k);
            for (const k of [other.keys, ...(other.alt ?? [])]) expect(browserPageKeys(false)).toContain(k);
        }
    });
});

describe("zoom steps", () => {
    it("moves to the next of Chromium's levels and stops at the ends", () => {
        expect(nextZoomStep(100, 1)).toBe(110);
        expect(nextZoomStep(100, -1)).toBe(90);
        expect(nextZoomStep(105, 1)).toBe(110);
        expect(nextZoomStep(105, -1)).toBe(100);
        expect(nextZoomStep(300, 1)).toBe(300);
        expect(nextZoomStep(30, -1)).toBe(30);
    });
});

describe("routing a key held back from a page", () => {
    const page = (id: number, blockId: string, ready = true) => ({
        getWebContentsId: () => {
            if (!ready) throw new Error("not ready");
            return id;
        },
        closest: () => ({ getAttribute: () => blockId }),
    });

    it("finds the block of the page whatever panel the layout has focused", () => {
        expect(blockIdOfPage(7, [page(3, "other", false), page(5, "a"), page(7, "b")])).toBe("b");
        expect(blockIdOfPage(9, [page(7, "b")])).toBeNull();
        expect(blockIdOfPage(null, [page(7, "b")])).toBeNull();
    });

    it("hands the key to the browser panel holding the page, else lets the window have it", () => {
        setKeyUtilPlatform("darwin");
        const seen: string[] = [];
        const browser = { viewType: "molten-browser", pageKeyDownHandler: () => (seen.push("browser"), true) };
        const ev = key("r", { meta: true }, true);
        expect(routeBrowserPageKey(ev, 7, [page(7, "b")], (id) => (id === "b" ? browser : null))).toBe(true);
        expect(seen).toEqual(["browser"]);
        expect(routeBrowserPageKey(ev, 7, [page(7, "b")], () => ({ viewType: "web" }))).toBe(false);
        expect(routeBrowserPageKey(ev, 8, [page(7, "b")], () => browser)).toBe(false);
    });
});
