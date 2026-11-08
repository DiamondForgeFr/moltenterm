// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The browser's Ctrl keys off macOS, the previous and next panel, find next and previous, F6 (#1759, FR-SHELL-139 AC8 to
// AC10, TC-SHELL-254): the key tables of each platform, read through Wave's own key matcher, and the rule that a terminal
// or a code editor keeps its Ctrl chords. Nothing here waits on a clock.

import { adaptFromReactOrNativeKeyEvent, checkKeyPressed, setKeyUtilPlatform } from "@/util/keyutil";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformShortcuts, Shortcuts } from "./registry";
import {
    EditorSelector,
    focusInTerminalOrEditor,
    KeyFocusFacts,
    registerWindowKeys,
    stepPanelId,
    WindowKeyActions,
    windowKeyBindings,
} from "./window-keys";

const KeyModelSource = fs.readFileSync(path.resolve(__dirname, "../../app/store/keymodel.ts"), "utf8");
const FocusSource = fs.readFileSync(path.resolve(__dirname, "./window-keys-focus.ts"), "utf8");

type Handler = (e: WaveKeyboardEvent) => boolean;

function fakeActions(inTerminalOrEditor = false) {
    const calls: string[] = [];
    const actions: WindowKeyActions = {
        newPanel: () => void calls.push("newPanel"),
        newView: () => void calls.push("newView"),
        closePanel: () => void calls.push("closePanel"),
        closeView: () => void calls.push("closeView"),
        topField: () => (calls.push("topField"), true),
        findStep: (d) => (calls.push(`findStep${d}`), true),
        stepPanel: (d) => (calls.push(`stepPanel${d}`), true),
        inTerminalOrEditor: () => inTerminalOrEditor,
    };
    return { actions, calls };
}

type Press = { key: string; meta?: boolean; alt?: boolean; ctrl?: boolean; shift?: boolean };

// A key as the window sees it (adaptFromReactOrNativeKeyEvent), through the same matcher the key model uses.
function press(p: Press): WaveKeyboardEvent {
    return adaptFromReactOrNativeKeyEvent({
        type: "keydown",
        key: p.key,
        code: p.key,
        metaKey: !!p.meta,
        altKey: !!p.alt,
        ctrlKey: !!p.ctrl,
        shiftKey: !!p.shift,
        repeat: false,
        location: 0,
    } as unknown as KeyboardEvent);
}

// What the key model does with a key: the first binding whose description matches runs; undefined when none does.
function dispatch(map: Map<string, Handler>, p: Press): boolean | undefined {
    const e = press(p);
    for (const [keys, handler] of map) {
        if (checkKeyPressed(e, keys)) {
            return handler(e);
        }
    }
    return undefined;
}

function sorted(map: Map<string, Handler>): string[] {
    return [...map.keys()].sort();
}

beforeEach(() => {
    setKeyUtilPlatform("darwin");
});

afterEach(() => {
    setKeyUtilPlatform("darwin");
    vi.restoreAllMocks();
});

describe("the key tables of each platform (FR-SHELL-139 AC8, AC9, AC10)", () => {
    it("binds on macOS only the panel keys, F6 and find previous: no Ctrl key for the window", () => {
        const { actions } = fakeActions();
        expect(sorted(windowKeyBindings(true, actions))).toEqual(
            ["Cmd:Alt:ArrowLeft", "Cmd:Alt:ArrowRight", "Ctrl:PageUp", "Ctrl:PageDown", "F6", "Shift:Cmd:g"].sort()
        );
    });

    it("binds off macOS the browser's Ctrl keys, the panel keys, F6 and find next and previous", () => {
        const { actions } = fakeActions();
        expect(sorted(windowKeyBindings(false, actions))).toEqual(
            [
                ...["Ctrl:t", "Ctrl:n", "Ctrl:w", "Ctrl:Shift:w", "Ctrl:l"],
                ...["Ctrl:PageUp", "Ctrl:PageDown", "F6", "Ctrl:g", "Ctrl:Shift:g"],
            ].sort()
        );
    });

    it("never binds the keys of the other platform, nor Cmd:g, which keymodel.ts keeps with the connection", () => {
        const { actions } = fakeActions();
        const mac = windowKeyBindings(true, actions);
        const other = windowKeyBindings(false, actions);
        for (const key of ["Ctrl:t", "Ctrl:n", "Ctrl:w", "Ctrl:Shift:w", "Ctrl:l", "Ctrl:g", "Ctrl:Shift:g"]) {
            expect(mac.has(key), key).toBe(false);
        }
        for (const key of ["Cmd:Alt:ArrowLeft", "Cmd:Alt:ArrowRight", "Shift:Cmd:g"]) {
            expect(other.has(key), key).toBe(false);
        }
        expect(mac.has("Cmd:g")).toBe(false);
        expect(other.has("Cmd:g")).toBe(false);
    });

    it("registers each registry entry that has an action, and every outside-a-terminal-or-editor entry has one", () => {
        for (const mac of [true, false]) {
            const { actions } = fakeActions();
            const bound = windowKeyBindings(mac, actions);
            for (const s of platformShortcuts(mac).filter((x) => x.outsideTerminalOrEditor)) {
                for (const keys of [s.keys, ...(s.alt ?? [])]) {
                    expect(bound.has(keys), `${s.id} ${keys} (macOS ${mac})`).toBe(true);
                }
            }
        }
        expect(Shortcuts.filter((s) => s.outsideTerminalOrEditor).every((s) => s.macOnly || s.notMac)).toBe(true);
    });

    it("adds its keys to a key map without removing the ones already there", () => {
        const { actions } = fakeActions();
        const keyMap = new Map<string, Handler>([["Cmd:t", () => true]]);
        registerWindowKeys(keyMap, true, actions);
        expect(keyMap.has("Cmd:t")).toBe(true);
        expect(keyMap.has("F6")).toBe(true);
    });
});

describe("macOS: ⌘⌥← ⌘⌥→, Ctrl+PageUp / PageDown, F6 and ⌘⇧G", () => {
    it("steps the panels with ⌘⌥← and ⌘⌥→, whatever the focus", () => {
        const { actions, calls } = fakeActions(true);
        const map = windowKeyBindings(true, actions);
        expect(dispatch(map, { key: "ArrowLeft", meta: true, alt: true })).toBe(true);
        expect(dispatch(map, { key: "ArrowRight", meta: true, alt: true })).toBe(true);
        expect(calls).toEqual(["stepPanel-1", "stepPanel1"]);
    });

    it("steps the panels with Ctrl+PageUp and Ctrl+PageDown, a terminal included", () => {
        const { actions, calls } = fakeActions(true);
        const map = windowKeyBindings(true, actions);
        expect(dispatch(map, { key: "PageUp", ctrl: true })).toBe(true);
        expect(dispatch(map, { key: "PageDown", ctrl: true })).toBe(true);
        expect(calls).toEqual(["stepPanel-1", "stepPanel1"]);
    });

    it("leaves ⌘←, ⌘→ and ⌥← alone: they are the page's back and forward and the shell's word moves", () => {
        const { actions, calls } = fakeActions();
        const map = windowKeyBindings(true, actions);
        expect(dispatch(map, { key: "ArrowLeft", meta: true })).toBeUndefined();
        expect(dispatch(map, { key: "ArrowRight", meta: true })).toBeUndefined();
        expect(dispatch(map, { key: "ArrowLeft", alt: true })).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it("does not bind Ctrl+Shift+PageUp / PageDown, which are the carpet's", () => {
        const { actions } = fakeActions();
        const map = windowKeyBindings(true, actions);
        expect(dispatch(map, { key: "PageUp", ctrl: true, shift: true })).toBeUndefined();
        expect(dispatch(map, { key: "PageDown", ctrl: true, shift: true })).toBeUndefined();
    });

    it("opens the top field with F6 outside a terminal or an editor and lets the program have the key in one", () => {
        const outside = fakeActions(false);
        expect(dispatch(windowKeyBindings(true, outside.actions), { key: "F6" })).toBe(true);
        expect(outside.calls).toEqual(["topField"]);
        const inside = fakeActions(true);
        expect(dispatch(windowKeyBindings(true, inside.actions), { key: "F6" })).toBe(false);
        expect(inside.calls).toEqual([]);
    });

    it("finds the previous match with ⌘⇧G, in a terminal too, and leaves Ctrl+G and Ctrl+T to the program", () => {
        const { actions, calls } = fakeActions(true);
        const map = windowKeyBindings(true, actions);
        expect(dispatch(map, { key: "G", meta: true, shift: true })).toBe(true);
        expect(dispatch(map, { key: "g", ctrl: true })).toBeUndefined();
        expect(dispatch(map, { key: "t", ctrl: true })).toBeUndefined();
        expect(dispatch(map, { key: "w", ctrl: true })).toBeUndefined();
        expect(calls).toEqual(["findStep-1"]);
    });
});

describe("Windows and Linux: the browser's Ctrl keys outside a terminal or an editor", () => {
    beforeEach(() => {
        setKeyUtilPlatform("linux");
    });

    const keys: { name: string; press: Press; call: string }[] = [
        { name: "Ctrl+T", press: { key: "t", ctrl: true }, call: "newPanel" },
        { name: "Ctrl+N", press: { key: "n", ctrl: true }, call: "newView" },
        { name: "Ctrl+W", press: { key: "w", ctrl: true }, call: "closePanel" },
        { name: "Ctrl+Shift+W", press: { key: "W", ctrl: true, shift: true }, call: "closeView" },
        { name: "Ctrl+L", press: { key: "l", ctrl: true }, call: "topField" },
        { name: "F6", press: { key: "F6" }, call: "topField" },
        { name: "Ctrl+G", press: { key: "g", ctrl: true }, call: "findStep1" },
        { name: "Ctrl+Shift+G", press: { key: "G", ctrl: true, shift: true }, call: "findStep-1" },
    ];

    it.each(keys)("$name acts with the focus outside a terminal or an editor", ({ press: p, call }) => {
        const { actions, calls } = fakeActions(false);
        expect(dispatch(windowKeyBindings(false, actions), p)).toBe(true);
        expect(calls).toEqual([call]);
    });

    it.each(keys)("$name reaches the program with the focus in a terminal or an editor", ({ press: p }) => {
        const { actions, calls } = fakeActions(true);
        expect(dispatch(windowKeyBindings(false, actions), p)).toBe(false);
        expect(calls).toEqual([]);
    });

    it("steps the panels with Ctrl+PageUp and Ctrl+PageDown in a terminal as well", () => {
        const { actions, calls } = fakeActions(true);
        const map = windowKeyBindings(false, actions);
        expect(dispatch(map, { key: "PageUp", ctrl: true })).toBe(true);
        expect(dispatch(map, { key: "PageDown", ctrl: true })).toBe(true);
        expect(calls).toEqual(["stepPanel-1", "stepPanel1"]);
    });

    it("does not take the Alt keys: Alt+T, Alt+N, Alt+W, Alt+L, Alt+G and Alt+arrows stay the key model's", () => {
        const { actions } = fakeActions(false);
        const map = windowKeyBindings(false, actions);
        for (const key of ["t", "n", "w", "l", "g"]) {
            expect(dispatch(map, { key, alt: true }), `Alt+${key}`).toBeUndefined();
        }
        expect(dispatch(map, { key: "W", alt: true, shift: true })).toBeUndefined();
        expect(dispatch(map, { key: "ArrowLeft", alt: true })).toBeUndefined();
        expect(dispatch(map, { key: "ArrowRight", alt: true })).toBeUndefined();
    });

    it("takes no Ctrl key a terminal needs and no other, such as Ctrl+Shift+T (reopen) or Ctrl+Shift+N", () => {
        const { actions } = fakeActions(false);
        const map = windowKeyBindings(false, actions);
        expect(dispatch(map, { key: "T", ctrl: true, shift: true })).toBeUndefined();
        expect(dispatch(map, { key: "N", ctrl: true, shift: true })).toBeUndefined();
        expect(dispatch(map, { key: "r", ctrl: true })).toBeUndefined();
        expect(dispatch(map, { key: "f", ctrl: true })).toBeUndefined();
    });

    it("has no ⌘⌥ arrows: off macOS ⌘ and ⌥ are both Alt, which is the page's back and forward", () => {
        const { actions } = fakeActions(false);
        const map = windowKeyBindings(false, actions);
        expect(dispatch(map, { key: "ArrowLeft", alt: true, meta: true })).toBeUndefined();
    });
});

describe("the keyboard focus is in a terminal or a code editor (FR-SHELL-139 AC8)", () => {
    const views: Record<string, string> = { term1: "term", page1: "molten-browser", files1: "preview", agent1: "term" };
    const viewOf = (id: string) => views[id] ?? null;
    const facts = (f: Partial<KeyFocusFacts>): KeyFocusFacts => ({ inSidebar: false, ...f });

    it("is true when the panel holding the DOM focus is a terminal", () => {
        expect(focusInTerminalOrEditor(facts({ domBlockId: "term1" }), viewOf)).toBe(true);
        expect(focusInTerminalOrEditor(facts({ domBlockId: "agent1" }), viewOf)).toBe(true);
    });

    it("is true when the DOM focus is inside a code editor, in the file editor panel or any other panel", () => {
        expect(focusInTerminalOrEditor(facts({ inEditor: true, domBlockId: "files1" }), viewOf)).toBe(true);
        expect(focusInTerminalOrEditor(facts({ inEditor: true, domBlockId: "page1" }), viewOf)).toBe(true);
        expect(focusInTerminalOrEditor(facts({ inEditor: true }), viewOf)).toBe(true);
    });

    it("is false in a panel that shows no editor, such as the file panel's directory or a rendered file", () => {
        expect(focusInTerminalOrEditor(facts({ inEditor: false, domBlockId: "files1" }), viewOf)).toBe(false);
        expect(focusInTerminalOrEditor(facts({ domBlockId: "files1" }), viewOf)).toBe(false);
    });

    it("is false in a web page, in any other panel, in the sidebar and with the focus outside every panel", () => {
        expect(focusInTerminalOrEditor(facts({ domBlockId: "page1" }), viewOf)).toBe(false);
        expect(focusInTerminalOrEditor(facts({ domBlockId: "files1" }), viewOf)).toBe(false);
        expect(focusInTerminalOrEditor(facts({ inSidebar: true, domBlockId: "term1" }), viewOf)).toBe(false);
        expect(focusInTerminalOrEditor(facts({ inSidebar: true, inEditor: true }), viewOf)).toBe(false);
        expect(focusInTerminalOrEditor(facts({}), viewOf)).toBe(false);
    });

    it("counts a key sent back from a page as pressed in that page's panel, whatever holds the DOM focus", () => {
        expect(focusInTerminalOrEditor(facts({ originBlockId: "page1", domBlockId: "term1" }), viewOf)).toBe(false);
        expect(focusInTerminalOrEditor(facts({ originBlockId: "page1", inEditor: true }), viewOf)).toBe(false);
        expect(focusInTerminalOrEditor(facts({ originBlockId: "term1", domBlockId: "page1" }), viewOf)).toBe(true);
    });

    it("is false for a panel whose view is unknown", () => {
        expect(focusInTerminalOrEditor(facts({ domBlockId: "gone" }), viewOf)).toBe(false);
    });

    it("reads Monaco's root element from the DOM focus, which the file, configuration and diff editors share", () => {
        expect(EditorSelector).toBe(".monaco-editor");
        expect(FocusSource).toContain("inEditor: active?.closest?.(EditorSelector) != null");
        expect(FocusSource).toContain("focusInTerminalOrEditor(currentKeyFocusFacts(), viewOfBlock)");
    });
});

describe("a code editor keeps its Ctrl keys off macOS (Ctrl+L, Ctrl+N, Ctrl+W, Ctrl+T, Ctrl+G, FR-SHELL-139 AC8)", () => {
    beforeEach(() => {
        setKeyUtilPlatform("linux");
    });

    const views: Record<string, string> = { files1: "preview", page1: "molten-browser" };
    const viewOf = (id: string) => views[id] ?? null;
    const guarded: { name: string; press: Press }[] = [
        { name: "Ctrl+L", press: { key: "l", ctrl: true } },
        { name: "Ctrl+N", press: { key: "n", ctrl: true } },
        { name: "Ctrl+W", press: { key: "w", ctrl: true } },
        { name: "Ctrl+T", press: { key: "t", ctrl: true } },
        { name: "Ctrl+G", press: { key: "g", ctrl: true } },
        { name: "Ctrl+Shift+W", press: { key: "W", ctrl: true, shift: true } },
        { name: "Ctrl+Shift+G", press: { key: "G", ctrl: true, shift: true } },
        { name: "F6", press: { key: "F6" } },
    ];

    // The window's real rule behind the guard, fed the facts of a focus: which Ctrl keys run, which reach the editor.
    function mapFor(f: Partial<KeyFocusFacts>) {
        const { actions, calls } = fakeActions();
        actions.inTerminalOrEditor = () => focusInTerminalOrEditor({ inSidebar: false, ...f }, viewOf);
        return { map: windowKeyBindings(false, actions), calls };
    }

    it.each(guarded)("$name reaches the editor with the focus inside it, whatever panel holds it", ({ press: p }) => {
        for (const f of [{ inEditor: true, domBlockId: "files1" }, { inEditor: true }]) {
            const { map, calls } = mapFor(f);
            expect(dispatch(map, p)).toBe(false);
            expect(calls).toEqual([]);
        }
    });

    it.each(guarded)("$name acts in the file panel when no editor holds the focus", ({ press: p }) => {
        const { map, calls } = mapFor({ domBlockId: "files1" });
        expect(dispatch(map, p)).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it("still steps the panels with Ctrl+PageUp and Ctrl+PageDown from an editor", () => {
        const { map, calls } = mapFor({ inEditor: true, domBlockId: "files1" });
        expect(dispatch(map, { key: "PageUp", ctrl: true })).toBe(true);
        expect(dispatch(map, { key: "PageDown", ctrl: true })).toBe(true);
        expect(calls).toEqual(["stepPanel-1", "stepPanel1"]);
    });

    it("lets a key held back from a page act even when an editor elsewhere kept the DOM focus", () => {
        const { map, calls } = mapFor({ originBlockId: "page1", inEditor: true });
        expect(dispatch(map, { key: "t", ctrl: true })).toBe(true);
        expect(calls).toEqual(["newPanel"]);
    });
});

describe("the order of the panels (FR-SHELL-139 AC9)", () => {
    const ids = ["a", "b", "c"];

    it("goes to the next and the previous panel and wraps at the ends", () => {
        expect(stepPanelId(ids, "a", 1)).toBe("b");
        expect(stepPanelId(ids, "b", 1)).toBe("c");
        expect(stepPanelId(ids, "c", 1)).toBe("a");
        expect(stepPanelId(ids, "c", -1)).toBe("b");
        expect(stepPanelId(ids, "a", -1)).toBe("c");
    });

    it("reaches the first panel going forward and the last going back when none is focused", () => {
        expect(stepPanelId(ids, null, 1)).toBe("a");
        expect(stepPanelId(ids, "gone", -1)).toBe("c");
    });

    it("has nowhere to go with fewer than two panels, so that the program keeps the key", () => {
        expect(stepPanelId(["a"], "a", 1)).toBeNull();
        expect(stepPanelId([], null, 1)).toBeNull();
        expect(stepPanelId(null, "a", -1)).toBeNull();
    });

    it("steps between two panels in both directions", () => {
        expect(stepPanelId(["a", "b"], "a", 1)).toBe("b");
        expect(stepPanelId(["a", "b"], "a", -1)).toBe("b");
    });
});

describe("how the key model uses them (keymodel.ts)", () => {
    it("registers the window keys before the keys held back from web pages are listed", () => {
        const register = KeyModelSource.indexOf("registerWindowKeys(globalKeyMap, isMacOS()");
        const held = KeyModelSource.indexOf("const allKeys = Array.from(globalKeyMap.keys())");
        expect(register).toBeGreaterThan(-1);
        expect(held).toBeGreaterThan(register);
    });

    it("steps an open find bar with ⌘G on macOS before it opens the connection, and never off macOS", () => {
        const start = KeyModelSource.indexOf('globalKeyMap.set("Cmd:g"');
        const body = KeyModelSource.slice(start, KeyModelSource.indexOf("\n    });", start));
        expect(body).toContain("isMacOS() && stepFindInFocusedPanel(1)");
        expect(body.indexOf("stepFindInFocusedPanel")).toBeLessThan(body.indexOf("openSwitchConnection"));
    });

    it("hands the window keys the actions of the Alt keys, not copies of them", () => {
        const start = KeyModelSource.indexOf("registerWindowKeys(globalKeyMap, isMacOS()");
        const body = KeyModelSource.slice(start, KeyModelSource.indexOf("});", start));
        expect(body).toContain("newView: openNewView");
        expect(body).toContain("closePanel: genericClose");
        expect(body).toContain("closeView: simpleCloseStaticTab");
        expect(body).toContain("handleCmdT");
        expect(body).toContain("topField: openTopFieldFromKey");
        expect(body).toContain("inTerminalOrEditor: keyboardFocusInTerminalOrEditor");
    });
});
