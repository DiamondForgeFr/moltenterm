// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A tab view draws its workspace's look before its first paint (#2390): a view built for a switch came on screen flat
// and look-less, then snapped to its look a few hundred milliseconds later, with a blank frame as main cleared its
// background on screen.

import { readFileSync } from "node:fs";
import * as jotai from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    sent: [] as any[],
    support: { translucent: true, blur: true } as any,
    supportFails: false,
}));

vi.mock("@/app/store/jotaiStore", async () => {
    const j = await import("jotai");
    return { globalStore: j.createStore() };
});

vi.mock("@/app/store/global", async () => {
    const j = await import("jotai");
    const settings = j.atom({
        "window:transparent": false,
        "window:blur": true,
        "window:opacity": 0.7,
        "window:texture": "paper",
        "window:textureintensity": 0.5,
    });
    return {
        atoms: { workspace: j.atom({ oid: "ws-1", meta: {} }), prefersReducedMotionAtom: j.atom(false) },
        getSettingsPrefixAtom: () => settings,
        getApi: () => ({
            getWindowLookSupport: () =>
                state.supportFails ? Promise.reject(new Error("gone")) : Promise.resolve(state.support),
            setWindowLook: (look: any) => state.sent.push(look),
        }),
    };
});

vi.mock("@/app/store/client-model", async () => {
    const j = await import("jotai");
    const clientAtom = j.atom({ meta: {} });
    return { ClientModel: { getInstance: () => ({ clientAtom, clientId: "c" }) } };
});

vi.mock("@/app/store/wos", () => ({}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./workspace-project", () => ({ readWorkspaceProject: () => ({ dir: "" }) }));

function fakeDocument() {
    const classes = new Set<string>();
    const props = new Map<string, string>();
    return {
        classes,
        props,
        documentElement: {
            classList: {
                toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
            },
            style: {
                setProperty: (k: string, v: string) => props.set(k, v),
                removeProperty: (k: string) => props.delete(k),
            },
        },
        querySelector: (): null => null,
    };
}

let doc: ReturnType<typeof fakeDocument>;

beforeEach(() => {
    state.sent = [];
    state.supportFails = false;
    doc = fakeDocument();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
});

import { primeWindowLook, WindowLookModel } from "./window-look";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";

describe("the look before the first paint (#2390)", () => {
    it("draws the workspace's look and tells main before anything renders", async () => {
        await primeWindowLook();
        expect(doc.classes.has("mt-translucent")).toBe(true);
        expect(doc.classes.has("mt-window-blur")).toBe(true);
        expect(doc.classes.has("mt-textured")).toBe(true);
        expect(doc.props.get("--mt-window-alpha")).toBe("0.7");
        expect(state.sent).toEqual([{ translucent: true, blur: true, reducedMotion: false }]);
        expect(globalStore.get(WindowLookModel.getInstance().supportAtom)).toEqual({ translucent: true, blur: true });
    });

    it("sends the app's reduced-motion setting with the first look, not only the system's", async () => {
        globalStore.set(atoms.prefersReducedMotionAtom as any, true);
        await primeWindowLook();
        expect(state.sent).toEqual([{ translucent: true, blur: true, reducedMotion: true }]);
        globalStore.set(atoms.prefersReducedMotionAtom as any, false);
    });

    it("tells main when reduced motion changes, even when the look does not", () => {
        const src = readFileSync("frontend/moltenterm-shell/window-look.tsx", "utf8");
        const applier = src.slice(src.indexOf("export function WindowLookApplier"));
        expect(applier).toContain("useAtomValue(atoms.prefersReducedMotionAtom)");
        expect(applier).toMatch(/ws\?\.oid, reducedMotion\]\);/);
        const tell = src.slice(src.indexOf("function tellWindow"));
        expect(tell.slice(0, tell.indexOf("\n}\n"))).toContain("atoms.prefersReducedMotionAtom");
    });

    it("draws and sends nothing when main cannot say what the window supports", async () => {
        state.supportFails = true;
        globalStore.set(WindowLookModel.getInstance().supportAtom, null);
        await primeWindowLook();
        expect(state.sent).toEqual([]);
        expect(doc.classes.size).toBe(0);
    });

    it("is awaited in wave.ts before the React root renders", () => {
        const wave = readFileSync("frontend/wave.ts", "utf8");
        const init = wave.slice(wave.indexOf("async function initWave("));
        expect(init.indexOf("await primeWindowLook()")).toBeGreaterThan(-1);
        expect(init.indexOf("await primeWindowLook()")).toBeLessThan(init.indexOf("root.render("));
        expect(init.indexOf("await primeWindowLook()")).toBeGreaterThan(init.indexOf("atoms.fullConfigAtom"));
    });

    it("draws a later change of look before the frame paints", () => {
        const src = readFileSync("frontend/moltenterm-shell/window-look.tsx", "utf8");
        const applier = src.slice(src.indexOf("export function WindowLookApplier"));
        expect(applier).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(drawn == null\)/);
    });
});

void jotai;
