// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Making a view from a panel (FR-SHELL-080, #2548): each destination, the panel left where it is, an agent's panel
// asking before anything moves. The app's own parts are fakes that record what was asked of them, so no test waits.

import { describe, expect, it } from "vitest";
import { createViewFromPanel, PanelViewDeps, PanelViewRequest } from "./panel-view-create";
import { AgentAnswer, PanelViewDestination, PanelViewNames } from "./panel-view-model";
import type { PinConfig } from "./view-pins-model";

const pinnedConfig: PinConfig = { tree: { pane: 0 }, panes: [{ view: "molten-browser", url: "molten:repo/pulls" }] };
const copyConfig: PinConfig = { tree: { pane: 0 }, panes: [{ view: "molten-browser", url: "https://example.com/a" }] };

const names: PanelViewNames = {
    context: "Client",
    workspace: "MoltenTerm",
    projectOf: (id) => (id === "p2" ? "Site" : "Desktop"),
    folderName: () => "Recipes",
};

type Fakes = {
    deps: PanelViewDeps;
    calls: string[];
    created: PanelViewRequest[];
    captures: { tabId: string; blockId: string; copy: boolean }[];
    notices: { text: string; tabId: string; key: string }[];
    placed: { tabId: string; before: string }[];
    folded: { folderId: string; tabId: string }[];
    fresh: string[];
    failures: unknown[];
};

function fakes(
    over: { agent?: boolean; answer?: AgentAnswer; holds?: boolean; fails?: boolean; tabId?: string } = {}
): Fakes {
    const calls: string[] = [];
    const rec: Fakes = {
        calls,
        created: [],
        captures: [],
        notices: [],
        placed: [],
        folded: [],
        fresh: [],
        failures: [],
        deps: null,
    };
    rec.deps = {
        sourceTabId: () => "tab-source",
        holds: () => over.holds ?? true,
        isAgent: () => over.agent ?? false,
        askAgent: async () => {
            calls.push("ask");
            return over.answer ?? null;
        },
        capture: async (tabId, blockId, copy) => {
            calls.push("capture");
            rec.captures.push({ tabId, blockId, copy });
            return copy ? copyConfig : pinnedConfig;
        },
        blockName: () => "Docs",
        names: () => names,
        createView: async (req) => {
            calls.push("create");
            if (over.fails) {
                throw new Error("wavesrv refused");
            }
            rec.created.push(req);
            return over.tabId ?? "tab-new";
        },
        placeBefore: async (tabId, before) => {
            calls.push("place");
            rec.placed.push({ tabId, before });
        },
        addToFolder: async (folderId, tabId) => {
            calls.push("folder");
            rec.folded.push({ folderId, tabId });
        },
        notice: (text, tabId, key) => {
            calls.push("notice");
            rec.notices.push({ text, tabId, key });
        },
        fresh: (...ids) => rec.fresh.push(...ids),
        failed: (e) => rec.failures.push(e),
        translate: (key, vars) => `${key} ${JSON.stringify(vars ?? {})}`,
    };
    return rec;
}

async function make(dest: PanelViewDestination, f: Fakes = fakes()) {
    const tabId = await createViewFromPanel({ blockId: "block-1", destination: dest }, f.deps);
    return { tabId, f };
}

describe("a view made at each destination", () => {
    it("pins it in the context: a pin of the top row, before the block it was dropped before", async () => {
        const { tabId, f } = await make({ kind: "pinned", before: "g2" });
        expect(tabId).toBe("tab-new");
        expect(f.created).toHaveLength(1);
        expect(f.created[0]).toMatchObject({ scope: "everywhere", beforePinId: "g2", name: "Docs", background: true });
        expect(f.placed).toEqual([]);
    });

    it("pins it in the workspace: a tile, placed before the tile it was dropped before", async () => {
        const { f } = await make({ kind: "workspace", before: "tile-2" });
        expect(f.created[0]).toMatchObject({ scope: "workspace", projectId: undefined, beforePinId: undefined });
        expect(f.placed).toEqual([{ tabId: "tab-new", before: "tile-2" }]);
    });

    it("makes it a view of a project's list, for that project, before the view it was dropped before", async () => {
        const { f } = await make({ kind: "views", projectId: "p2", before: "tab-9" });
        expect(f.created[0]).toMatchObject({ scope: "temporary", projectId: "p2", beforePinId: undefined });
        expect(f.placed).toEqual([{ tabId: "tab-new", before: "tab-9" }]);
        expect(f.folded).toEqual([]);
    });

    it("puts it in a folder of the project's Views when one is chosen, and places it nowhere else", async () => {
        const { f } = await make({ kind: "views", projectId: "p1", folderId: "f1" });
        expect(f.folded).toEqual([{ folderId: "f1", tabId: "tab-new" }]);
        expect(f.placed).toEqual([]);
    });

    it("never gives a pin or a tile a folder", async () => {
        for (const dest of [{ kind: "pinned" }, { kind: "workspace" }] as PanelViewDestination[]) {
            const { f } = await make(dest);
            expect(f.folded).toEqual([]);
        }
    });

    it("says where the view was made, with its name, and offers to open it without leaving the current view", async () => {
        const { f } = await make({ kind: "pinned" });
        expect(f.notices).toHaveLength(1);
        expect(f.notices[0].tabId).toBe("tab-new");
        expect(f.notices[0].key).toBe("sidebar.panelView.createdPinned");
        expect(f.notices[0].text).toContain('"name":"Docs"');
        expect(f.created[0].background).toBe(true);
        expect(f.fresh).toEqual(["tab-new"]);
    });

    it("tells the notice after the view is placed, so it never names a place that is not there yet", async () => {
        const { f } = await make({ kind: "views", folderId: "f1" });
        expect(f.calls.indexOf("notice")).toBeGreaterThan(f.calls.indexOf("folder"));
    });
});

describe("the source panel is left where it is", () => {
    it("copies a view's panel, without moving it, whatever the destination", async () => {
        for (const dest of [{ kind: "pinned" }, { kind: "workspace" }, { kind: "views" }] as PanelViewDestination[]) {
            const { f } = await make(dest);
            expect(f.created[0].adopt).toBeUndefined();
        }
    });

    it("reads the panel of the view on screen, and only that panel", async () => {
        const { f } = await make({ kind: "views" });
        expect(f.captures.every((c) => c.tabId === "tab-source" && c.blockId === "block-1")).toBe(true);
    });

    it("keeps where the panel is in the copy a view holds: the exact address, the terminal's folder", async () => {
        const { f } = await make({ kind: "views" });
        expect(f.captures).toEqual([{ tabId: "tab-source", blockId: "block-1", copy: true }]);
        expect(f.created[0].config).toBe(copyConfig);
        expect(f.created[0].instanceConfig).toBeUndefined();
    });

    it("pins what a pin keeps (it follows the project) and shows this workspace the exact copy", async () => {
        const { f } = await make({ kind: "workspace" });
        expect(f.captures.map((c) => c.copy)).toEqual([false, true]);
        expect(f.created[0].config).toBe(pinnedConfig);
        expect(f.created[0].instanceConfig).toBe(copyConfig);
    });

    it("does nothing for a panel the view on screen no longer holds", async () => {
        const f = fakes({ holds: false });
        const { tabId } = await make({ kind: "views" }, f);
        expect(tabId).toBeNull();
        expect(f.calls).toEqual([]);
    });

    it("does nothing without a destination", async () => {
        const f = fakes();
        const tabId = await createViewFromPanel({ blockId: "block-1", destination: null }, f.deps);
        expect(tabId).toBeNull();
        expect(f.calls).toEqual([]);
    });
});

describe("an agent's panel asks before it moves", () => {
    it("asks first: nothing is read or made before the answer", async () => {
        const f = fakes({ agent: true, answer: "stay" });
        await make({ kind: "views" }, f);
        expect(f.calls[0]).toBe("ask");
        expect(f.calls.indexOf("capture")).toBeGreaterThan(0);
        expect(f.calls.indexOf("create")).toBeGreaterThan(f.calls.indexOf("ask"));
    });

    it("moves the panel itself into the new view on Move the agent", async () => {
        const f = fakes({ agent: true, answer: "move" });
        const { tabId } = await make({ kind: "views" }, f);
        expect(tabId).toBe("tab-new");
        expect(f.created[0].adopt).toEqual({ blockid: "block-1", fromtabid: "tab-source" });
    });

    it("makes the view with an empty agent slot on Leave it here, the agent staying where it is", async () => {
        const f = fakes({ agent: true, answer: "stay" });
        const { tabId } = await make({ kind: "workspace" }, f);
        expect(tabId).toBe("tab-new");
        expect(f.created[0].adopt).toBeUndefined();
    });

    it("makes nothing when the question is dismissed", async () => {
        const f = fakes({ agent: true, answer: null });
        const { tabId } = await make({ kind: "pinned" }, f);
        expect(tabId).toBeNull();
        expect(f.calls).toEqual(["ask"]);
        expect(f.notices).toEqual([]);
    });

    it("never asks about a panel that holds no agent", async () => {
        const f = fakes({ agent: false });
        await make({ kind: "views" }, f);
        expect(f.calls).not.toContain("ask");
    });
});

describe("when the view cannot be made", () => {
    it("says so and leaves everything as it was", async () => {
        const f = fakes({ fails: true });
        const { tabId } = await make({ kind: "views" }, f);
        expect(tabId).toBeNull();
        expect(f.failures).toHaveLength(1);
        expect(f.notices).toEqual([]);
        expect(f.fresh).toEqual([]);
    });

    it("makes nothing when wavesrv answers no view", async () => {
        const f = fakes({ tabId: "" });
        const { tabId } = await make({ kind: "views" }, f);
        expect(tabId).toBeNull();
        expect(f.notices).toEqual([]);
    });
});
