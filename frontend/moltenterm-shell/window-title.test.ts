// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWindowTitleTab, windowTabName } from "./window-title";

const objects = vi.hoisted(() => ({ atoms: new Map<string, unknown>() }));

vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    return {
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: (oref: string) => {
            if (!objects.atoms.has(oref)) {
                objects.atoms.set(oref, atom(null));
            }
            return objects.atoms.get(oref);
        },
    };
});
vi.mock("./tab-identity-ui", () => ({ getHomeDir: () => "/Users/me" }));

function put(oref: string, value: unknown) {
    const found = objects.atoms.get(oref) as PrimitiveAtom<unknown>;
    const target = found ?? (atom(null) as PrimitiveAtom<unknown>);
    objects.atoms.set(oref, target);
    globalStore.set(target, value);
}

describe("the window title (#1345)", () => {
    const doc = { title: "" };

    beforeEach(() => {
        objects.atoms.clear();
        vi.stubGlobal("document", doc);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("names a view with Wave's generic name after its first panel, once the panel exists", () => {
        const tab = { oid: "t1", name: "T1", blockids: [] as string[] } as Tab;
        put("tab:t1", tab);
        setWindowTitleTab(tab);
        expect(doc.title).toBe("MoltenTerm - T1");

        put("tab:t1", { ...tab, blockids: ["b1"] });
        put("block:b1", { oid: "b1", meta: { view: "term", "cmd:cwd": "/Users/me/src/api" } });
        expect(doc.title).toBe("MoltenTerm - api");
    });

    it("keeps a name the user typed", () => {
        const tab = { oid: "t2", name: "Release", blockids: ["b2"] } as Tab;
        put("tab:t2", tab);
        put("block:b2", { oid: "b2", meta: { view: "term", "cmd:cwd": "/Users/me/src/api" } });
        setWindowTitleTab(tab);
        expect(doc.title).toBe("MoltenTerm - Release");
    });

    it("tells the generic name from a typed one", () => {
        expect(windowTabName({ name: "T3" } as Tab, { view: "preview", file: "/tmp/todo.md" })).toBe("todo.md");
        expect(windowTabName({ name: "T3" } as Tab, null)).toBe("T3");
    });
});
