// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/hook/useDimensions", () => ({ useOnResize: vi.fn() }));
vi.mock("./layoutAtom", async () => {
    const { atom } = await import("jotai");
    return { getLayoutStateAtomFromTab: () => atom(null) };
});
vi.mock("../../moltenterm-shell/gone-block-leaves", () => ({ watchGoneBlockLeaves: vi.fn() }));
vi.mock("./layoutModel", () => ({
    LayoutModel: class {
        moltenView360 = { dispose: vi.fn() };
    },
}));
vi.mock("@/app/store/global", async () => {
    const { atom, createStore } = await import("jotai");
    const tabAtom = atom({ oid: "tab-1" });
    return {
        atoms: { staticTabId: atom("tab-1") },
        globalStore: createStore(),
        WOS: { makeORef: (type: string, id: string) => `${type}:${id}`, getWaveObjectAtom: () => tabAtom },
    };
});

import { deleteLayoutModelForTab, getLayoutModelForStaticTab } from "./layoutModelHooks";

function view360Of(model: unknown) {
    return (model as { moltenView360: { dispose: ReturnType<typeof vi.fn> } }).moltenView360;
}

beforeEach(() => {
    deleteLayoutModelForTab("tab-1");
});

describe("deleteLayoutModelForTab (#2154, AC-4)", () => {
    it("releases the 360 model's subscriptions with the tab's layout model", () => {
        const model = getLayoutModelForStaticTab();
        expect(view360Of(model).dispose).not.toHaveBeenCalled();
        deleteLayoutModelForTab("tab-1");
        expect(view360Of(model).dispose).toHaveBeenCalledTimes(1);
    });

    it("drops the layout model: the tab's next one is a new model, with a 360 model of its own", () => {
        const model = getLayoutModelForStaticTab();
        deleteLayoutModelForTab("tab-1");
        const next = getLayoutModelForStaticTab();
        expect(next).not.toBe(model);
        expect(view360Of(next).dispose).not.toHaveBeenCalled();
    });

    it("does not dispose twice when the tab is deleted twice", () => {
        const model = getLayoutModelForStaticTab();
        deleteLayoutModelForTab("tab-1");
        deleteLayoutModelForTab("tab-1");
        expect(view360Of(model).dispose).toHaveBeenCalledTimes(1);
    });

    it("does nothing for a tab that has no layout model", () => {
        expect(() => deleteLayoutModelForTab("unknown-tab")).not.toThrow();
    });
});
