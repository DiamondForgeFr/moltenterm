// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewDisplayName } from "./tab-identity-ui";

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

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    return {
        atoms: { workspace: atom(null) },
        globalStore,
        getApi: () => ({ getHomeDir: () => "/Users/me" }),
    };
});

function put(oref: string, value: unknown) {
    const found = objects.atoms.get(oref) as PrimitiveAtom<unknown>;
    const target = found ?? (atom(null) as PrimitiveAtom<unknown>);
    objects.atoms.set(oref, target);
    globalStore.set(target, value);
}

async function setWorkspace(tabids: string[]) {
    const { atoms } = await import("@/app/store/global");
    globalStore.set(atoms.workspace as PrimitiveAtom<Workspace>, { oid: "ws", tabids } as Workspace);
}

function view(tabId: string, name: string, meta: Record<string, unknown>): Tab {
    const tab = { oid: tabId, name, blockids: [`b-${tabId}`] } as Tab;
    put(`tab:${tabId}`, tab);
    put(`block:b-${tabId}`, { oid: `b-${tabId}`, meta });
    return tab;
}

describe("the name a kept view takes (#1669)", () => {
    beforeEach(() => {
        objects.atoms.clear();
    });

    it("names each view as its sidebar line does, never T<n>, numbering a real duplicate only", async () => {
        const files = view("t1", "T1", { view: "preview", file: "/src/roman" });
        const term = view("t2", "T2", { view: "term", "cmd:cwd": "/src/roman" });
        const again = view("t3", "T3", { view: "preview", file: "/src/roman" });
        const typed = view("t4", "Draft", { view: "preview", file: "/src/roman" });
        await setWorkspace(["t1", "t2", "t3", "t4"]);
        expect(viewDisplayName(files)).toBe("Files · roman");
        expect(viewDisplayName(term)).toBe("Terminal · roman");
        expect(viewDisplayName(again)).toBe("Files · roman 2");
        expect(viewDisplayName(typed)).toBe("Draft");
    });

    it("words a view named by its key and never numbers it", async () => {
        const meta = { "molten:viewnamekey": "workspaceViews.names.view" } as unknown as MetaType;
        const keyed = { ...view("t5", "workspaceViews.names.view", { view: "term" }), meta };
        const twin = { ...view("t6", "workspaceViews.names.view", { view: "term" }), meta };
        put("tab:t5", keyed);
        put("tab:t6", twin);
        await setWorkspace(["t5", "t6"]);
        expect(viewDisplayName(keyed)).toBe("View");
        expect(viewDisplayName(twin)).toBe("View");
    });

    it("names a view of another workspace without a number", async () => {
        await setWorkspace([]);
        const other = view("t9", "T9", { view: "term", "cmd:cwd": "/Users/me" });
        expect(viewDisplayName(other)).toBe("Terminal · ~");
    });
});
