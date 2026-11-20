// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", () => ({ atoms: {}, globalStore: {} }));
vi.mock("@/app/store/wos", () => ({ makeORef: (): string => "", getObjectValue: (): null => null }));
vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: (): null => null }));
vi.mock("./layout-frames", () => ({
    arriving: () => false,
    contentElement: (): null => null,
    leaving: () => false,
    switchLayoutOn: () => true,
}));
vi.mock("./layout-store", () => ({ loadLayout: (): null => null, saveLayout: () => {} }));

import { measureLayout, RememberedLayout } from "./layout-memory";
import { RecordFacts, recordDecision } from "./layout-recorder";

const Window = { width: 1600, height: 1000 };
const Content = { left: 264, top: 0, width: 1336, height: 1000 };
const Two = [
    { id: "b1", kind: "term", rect: { left: 264, top: 0, width: 668, height: 1000 } },
    { id: "b2", kind: "web", rect: { left: 932, top: 0, width: 668, height: 1000 } },
];

function measured(blocks = Two): RememberedLayout {
    return measureLayout("ws-alpha", "tab-1", Content, Window, blocks, 5);
}

const Shown: RecordFacts = { visible: true, switching: false, activeTabId: "tab-1", tabBlocks: 2 };

describe("when a view writes its remembered layout (#2407)", () => {
    it("writes the view the workspace shows, once its panels moved", () => {
        const out = recordDecision(measured(), null, "tab-1", Shown);
        expect(out).toMatchObject({ save: true, retry: false });
        expect(recordDecision(measured(), out.layout, "tab-1", Shown)).toMatchObject({ save: false, retry: false });
    });

    it("writes nothing for a view parked visible that the workspace no longer shows", () => {
        const kept = measured();
        const out = recordDecision(measured(Two.slice(0, 1)), kept, "tab-1", { ...Shown, activeTabId: "tab-2" });
        expect(out).toEqual({ layout: kept, save: false, retry: false });
    });

    it("writes an empty tab as empty, so another view's layout never stays the workspace's", () => {
        const other = measured();
        const out = recordDecision(measured([]), other, "tab-1", { ...Shown, tabBlocks: 0 });
        expect(out.save).toBe(true);
        expect(out.layout.panels).toEqual([]);
    });

    it("measures again a tab whose panels are still mounting, and a view in the middle of a switch", () => {
        const kept = measured();
        expect(recordDecision(measured([]), kept, "tab-1", Shown)).toEqual({ layout: kept, save: false, retry: true });
        expect(recordDecision(measured(), kept, "tab-1", { ...Shown, switching: true })).toEqual({
            layout: kept,
            save: false,
            retry: true,
        });
    });

    it("writes nothing while hidden", () => {
        expect(recordDecision(measured(), null, "tab-1", { ...Shown, visible: false }).save).toBe(false);
    });
});
