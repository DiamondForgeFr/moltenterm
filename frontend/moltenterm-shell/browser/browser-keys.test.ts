// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { setKeyUtilPlatform } from "@/util/keyutil";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatShortcutById } from "../shortcuts/format";
import { findShortcut } from "../shortcuts/registry";
import {
    blockIdOfPage,
    browserKeyAction,
    BrowserKeyAddress,
    BrowserKeyBack,
    BrowserKeyFind,
    BrowserKeyForward,
    BrowserKeyHardReload,
    BrowserKeyInspect,
    BrowserKeyReload,
    BrowserKeyStop,
    BrowserKeyTarget,
    BrowserKeyZoomIn,
    BrowserKeyZoomOut,
    BrowserKeyZoomReset,
    browserPageKeys,
    nextZoomStep,
    pageHistoryKey,
    registerHistoryKeys,
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

describe("the window's back and forward keys (#1744, FR-SHELL-139)", () => {
    const browser = (answer = true) => {
        const seen: number[] = [];
        return {
            seen,
            model: {
                viewType: "molten-browser",
                historyKeyHandler: (direction: 1 | -1) => (seen.push(direction), answer),
            } as BrowserKeyTarget,
        };
    };
    const focus = (blockId: string, models: Record<string, BrowserKeyTarget>) => ({
        focusedBlockId: () => blockId,
        modelOf: (id: string) => models[id],
    });

    it("hands back and forward to the browser panel that holds the focus, page or controls", () => {
        const b = browser();
        expect(pageHistoryKey(-1, focus("b", { b: b.model }))).toBe(true);
        expect(pageHistoryKey(1, focus("b", { b: b.model }))).toBe(true);
        expect(b.seen).toEqual([-1, 1]);
    });

    it("lets the browser panel keep the key even when its page has no history, so a view never switches from a page", () => {
        const b = browser(true);
        expect(pageHistoryKey(-1, focus("b", { b: b.model }))).toBe(true);
    });

    it("leaves the key to the window when the focus is in a terminal or any other panel", () => {
        const b = browser();
        const models = { b: b.model, t: { viewType: "term" } as BrowserKeyTarget };
        expect(pageHistoryKey(-1, focus("t", models))).toBe(false);
        expect(pageHistoryKey(1, focus("t", models))).toBe(false);
        expect(b.seen).toEqual([]);
    });

    it("leaves the key to the window when no panel holds the focus (the sidebar, the top field) or the panel is unknown", () => {
        const b = browser();
        expect(pageHistoryKey(-1, focus(null, { b: b.model }))).toBe(false);
        expect(pageHistoryKey(-1, focus("gone", { b: b.model }))).toBe(false);
        expect(b.seen).toEqual([]);
    });

    it("leaves the key to the window when the panel declines it (a dialog is open)", () => {
        const b = browser(false);
        expect(pageHistoryKey(1, focus("b", { b: b.model }))).toBe(false);
        expect(b.seen).toEqual([1]);
    });

    it("binds Alt+← and Alt+→ off macOS only, by direction", () => {
        const answered: number[] = [];
        const linux = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerHistoryKeys(linux, false, (direction) => (answered.push(direction), true));
        expect([...linux.keys()]).toEqual(["Alt:ArrowLeft", "Alt:ArrowRight"]);
        linux.get("Alt:ArrowLeft")(null);
        linux.get("Alt:ArrowRight")(null);
        expect(answered).toEqual([-1, 1]);
        const mac = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerHistoryKeys(mac, true, () => true);
        expect([...mac.keys()]).toEqual([]);
    });

    it("keeps the keys the registry and the page table agree on", () => {
        setKeyUtilPlatform("darwin");
        expect(browserKeyAction(key("[", { meta: true }, true), true)).toBe(BrowserKeyBack);
        expect(browserKeyAction(key("]", { meta: true, shift: true }, true), true)).toBeNull();
        expect(findShortcut("browser-back").keys).toBe("Cmd:[");
        expect(findShortcut("browser-forward-other").keys).toBe("Alt:ArrowRight");
        expect(findShortcut("previous-tab").keys).toBe("Cmd:[");
        expect(findShortcut("previous-tab").alt).toEqual(["Shift:Cmd:["]);
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

    it("leaves ⌘T and ⌘N to the window: pressed in a page they reach the key model like anywhere else (#1742)", () => {
        const handler = (e: WaveKeyboardEvent) => browserKeyAction(e, true) != null;
        const browser = { viewType: "molten-browser", pageKeyDownHandler: handler };
        setKeyUtilPlatform("darwin");
        for (const letter of ["t", "n"]) {
            const ev = key(letter, { meta: true }, true);
            expect(browserKeyAction(ev, true)).toBeNull();
            expect(routeBrowserPageKey(ev, 7, [page(7, "b")], () => browser)).toBe(false);
        }
        setKeyUtilPlatform("linux");
        const alt = key("t", { alt: true }, false);
        expect(browserKeyAction(alt, false)).toBeNull();
        expect(browserPageKeys(false)).not.toContain("Cmd:t");
        expect(browserPageKeys(true)).not.toContain("Cmd:t");
    });
});

describe("the inspect toggle (#2310, FR-BRW-022 AC3, TC-BRW-053)", () => {
    const KeyModelSource = readFileSync(resolve(__dirname, "../../app/store/keymodel.ts"), "utf8");

    it("is ⌥⌘I on macOS, by its key or, where Option changes the character, by its code", () => {
        setKeyUtilPlatform("darwin");
        expect(browserKeyAction(key("i", { meta: true, alt: true }, true), true)).toBe(BrowserKeyInspect);
        const dead = { ...key("ˆ", { meta: true, alt: true }, true), code: "KeyI" };
        expect(browserKeyAction(dead, true)).toBe(BrowserKeyInspect);
        expect(browserKeyAction(key("i", { meta: true }, true), true)).toBeNull();
        expect(browserKeyAction(key("i", { control: true, shift: true }, true), true)).toBeNull();
    });

    it("is Ctrl+Shift+I on Windows and Linux, never Alt+Option+I", () => {
        setKeyUtilPlatform("linux");
        expect(browserKeyAction(key("I", { control: true, shift: true }, false), false)).toBe(BrowserKeyInspect);
        expect(browserKeyAction(key("i", { alt: true, meta: true }, false), false)).toBeNull();
    });

    it("is held back from pages and listed in the shortcuts sheet with the platform's glyphs", () => {
        expect(browserPageKeys(true)).toEqual(expect.arrayContaining(["Cmd:Alt:i", "Cmd:Alt:c{KeyI}"]));
        expect(browserPageKeys(false)).toContain("Ctrl:Shift:i");
        expect(findShortcut("browser-inspect")).toMatchObject({ keys: "Cmd:Alt:i", macOnly: true, scope: "browser" });
        expect(findShortcut("browser-inspect-other")).toMatchObject({ keys: "Ctrl:Shift:i", notMac: true });
        expect(formatShortcutById("browser-inspect", true)).toBe("⌥⌘I");
        expect(formatShortcutById("browser-inspect-other", false)).toBe("Ctrl+Shift+I");
    });

    it("wins over the terminals' multi-input while a web page panel has the focus, off macOS only", () => {
        const start = KeyModelSource.indexOf('globalKeyMap.set("Ctrl:Shift:i"');
        const body = KeyModelSource.slice(start, KeyModelSource.indexOf("\n    });", start));
        expect(body).toContain("!isMacOS() && focusedBrowserPanelTakes(waveEvent)");
        expect(body.indexOf("focusedBrowserPanelTakes")).toBeLessThan(body.indexOf("isTermMultiInput"));
    });
});
