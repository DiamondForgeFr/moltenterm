// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A call to action inside a panel opens its panel beside, in the same view (#1844, FR-SHELL-139 AC13): the choice
// between reuse, a panel beside, a new view and the app action's rules, on a faked store and layout.

import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
    objects: {} as Record<string, any>,
    metas: {} as Record<string, Record<string, any>>,
    laidOut: new Set<string>(),
    layout: {
        magnifiedNodeId: null as string,
        getNodeByBlockId: (_blockId: string): any => null,
        magnifyNodeToggle: (_nodeId: string, _on: boolean): void => {},
        focusNode: (_nodeId: string): void => {},
    },
    focused: null as string,
    createBlock: (async (..._args: any[]) => "created") as (...args: any[]) => Promise<any>,
    createBlockSplitHorizontally: (async (..._args: any[]) => "split") as (...args: any[]) => Promise<any>,
    createTab: (..._args: any[]): void => {},
    setMeta: (async (..._args: any[]) => {}) as (...args: any[]) => Promise<any>,
    openPanelBeside: (async (..._args: any[]) => "beside-id") as (...args: any[]) => Promise<any>,
    reveal: (..._args: any[]): void => {},
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { staticTabId: atom("t1"), workspace: atom({ oid: "w1", tabids: ["t1"] }) },
        createBlock: (...args: any[]) => env.createBlock(...args),
        createBlockSplitHorizontally: (...args: any[]) => env.createBlockSplitHorizontally(...args),
        getApi: () => ({ createTab: (...args: any[]) => env.createTab(...args) }),
        getFocusedBlockId: () => env.focused,
    };
});
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getObjectValue: (oref: string) => env.objects[oref],
    reloadWaveObject: async (oref: string) => env.objects[oref],
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetMetaCommand: async (_client: unknown, data: { oref: string }) => env.metas[data.oref],
        SetMetaCommand: (...args: any[]) => env.setMeta(...args),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    return { ClientModel: { getInstance: () => ({ clientAtom: atom(null) }) } };
});
vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: () => env.layout }));
vi.mock("./hidden-tabs", () => ({ projectTabIds: () => [] }));
vi.mock("./opener-tab", () => ({ showTabFromHere: () => {} }));
vi.mock("./split/add-beside", () => ({ openPanelBeside: (...args: any[]) => env.openPanelBeside(...args) }));
vi.mock("./view360/carpet-reveal", () => ({ revealPanelOnCarpet: (...args: any[]) => env.reveal(...args) }));

import { createBesideFocused, openFromPanel } from "./app-panel";

const CicdDef = { meta: { view: "molten-cicd" } } as BlockDef;

function setTab(blocks: Record<string, Record<string, any>>, tabMeta: Record<string, any> = {}) {
    env.objects["tab:t1"] = { oid: "t1", blockids: Object.keys(blocks), meta: tabMeta };
    env.metas = {};
    env.laidOut = new Set(Object.keys(blocks));
    for (const [blockId, meta] of Object.entries(blocks)) {
        env.metas[`block:${blockId}`] = meta;
    }
}

beforeEach(() => {
    env.focused = null;
    env.layout.magnifiedNodeId = null;
    env.layout.getNodeByBlockId = (blockId) => (env.laidOut.has(blockId) ? { id: `n-${blockId}` } : null);
    env.layout.magnifyNodeToggle = vi.fn();
    env.layout.focusNode = vi.fn();
    env.createBlock = vi.fn(async () => "created");
    env.createBlockSplitHorizontally = vi.fn(async () => "split");
    env.createTab = vi.fn();
    env.setMeta = vi.fn(async () => {});
    env.openPanelBeside = vi.fn(async () => "beside-id");
    env.reveal = vi.fn();
    setTab({ src: { view: "molten-project" }, term: { view: "term" } });
});

describe("a call to action opens its panel beside the panel it is in", () => {
    it("lays a new panel to the right of the source, in the same view, never a new view", async () => {
        await openFromPanel({ blockId: "src" }, CicdDef);
        expect(env.openPanelBeside).toHaveBeenCalledWith("src", CicdDef);
        expect(env.createTab).not.toHaveBeenCalled();
        expect(env.createBlock).not.toHaveBeenCalled();
    });

    it("does so in a pinned view too: the Project tab no longer sends the panel to a new view", async () => {
        setTab({ src: { view: "molten-project" } }, { "molten:projecttab": true });
        await openFromPanel({ blockId: "src" }, CicdDef);
        expect(env.openPanelBeside).toHaveBeenCalledWith("src", CicdDef);
        expect(env.createTab).not.toHaveBeenCalled();
    });

    it("hands the panel what was asked when it is created", async () => {
        await openFromPanel({ blockId: "src" }, CicdDef, { patch: { tab: "remote" } });
        expect(env.openPanelBeside).toHaveBeenCalledWith("src", { meta: { view: "molten-cicd", tab: "remote" } });
    });

    it("still splits the source when no column can be laid out beside it", async () => {
        env.openPanelBeside = vi.fn(async () => null);
        await openFromPanel({ blockId: "src" }, CicdDef);
        expect(env.createBlockSplitHorizontally).toHaveBeenCalledWith(CicdDef, "src", "after");
        expect(env.createTab).not.toHaveBeenCalled();
    });
});

describe("a panel of that kind in the view is reused", () => {
    beforeEach(() => setTab({ src: { view: "molten-project" }, ci: { view: "molten-cicd" } }));

    it("focuses it and turns the 360 carpet to it, without a second panel", async () => {
        await openFromPanel({ blockId: "src" }, CicdDef);
        expect(env.layout.focusNode).toHaveBeenCalledWith("n-ci");
        expect(env.reveal).toHaveBeenCalledWith("ci");
        expect(env.openPanelBeside).not.toHaveBeenCalled();
        expect(env.createTab).not.toHaveBeenCalled();
    });

    it("navigates it to what the call to action names", async () => {
        await openFromPanel({ blockId: "src" }, CicdDef, { patch: { tab: "remote" } });
        expect(env.setMeta).toHaveBeenCalledWith({}, { oref: "block:ci", meta: { tab: "remote" } });
        expect(env.layout.focusNode).toHaveBeenCalledWith("n-ci");
    });

    it("brings it out of a magnified panel's shadow first", async () => {
        env.layout.magnifiedNodeId = "n-src";
        await openFromPanel({ blockId: "src" }, CicdDef);
        expect(env.layout.magnifyNodeToggle).toHaveBeenCalledWith("n-src", false);
        expect(env.layout.focusNode).toHaveBeenCalledWith("n-ci");
    });

    it("keeps a magnified panel when it is the one asked for", async () => {
        env.layout.magnifiedNodeId = "n-ci";
        await openFromPanel({ blockId: "src" }, CicdDef);
        expect(env.layout.magnifyNodeToggle).not.toHaveBeenCalled();
    });

    it("matches the same file for a file's preview, and any panel for a match the caller sets", async () => {
        setTab({ src: { view: "molten-project" }, doc: { view: "preview", file: "/r/a.md" } });
        await openFromPanel({ blockId: "src" }, { meta: { view: "preview", file: "/r/b.md" } });
        expect(env.openPanelBeside).toHaveBeenCalledTimes(1);
        await openFromPanel({ blockId: "src" }, { meta: { view: "preview", file: "/r/a.md" } });
        expect(env.layout.focusNode).toHaveBeenCalledWith("n-doc");
        expect(env.openPanelBeside).toHaveBeenCalledTimes(1);
    });
});

describe("a new view only when the call to action asks for one", () => {
    it("opens it from the click's Shift, with the panel at hand or not", async () => {
        setTab({ src: { view: "molten-project" }, ci: { view: "molten-cicd" } });
        await openFromPanel({ blockId: "src", newView: true }, CicdDef);
        expect(env.createTab).toHaveBeenCalledWith(CicdDef);
        expect(env.openPanelBeside).not.toHaveBeenCalled();
        expect(env.layout.focusNode).not.toHaveBeenCalled();
    });

    it("carries what was asked into the new view", async () => {
        await openFromPanel({ blockId: "src", newView: true }, CicdDef, { patch: { tab: "remote" } });
        expect(env.createTab).toHaveBeenCalledWith({ meta: { view: "molten-cicd", tab: "remote" } });
    });
});

describe("without a panel laid out to open beside, it is an app action (FR-SHELL-094)", () => {
    it("adds the panel to a temporary view", async () => {
        await openFromPanel({ blockId: "gone" }, CicdDef);
        expect(env.createBlock).toHaveBeenCalledWith(CicdDef, false, false);
        expect(env.openPanelBeside).not.toHaveBeenCalled();
    });

    it("leaves a pinned view as the developer pinned it", async () => {
        setTab({ src: { view: "molten-project" } }, { "molten:projecttab": true });
        await openFromPanel({ blockId: null }, CicdDef);
        expect(env.createTab).toHaveBeenCalledWith(CicdDef);
        expect(env.createBlock).not.toHaveBeenCalled();
    });
});

describe("a link's panel opens beside the panel it was clicked in", () => {
    it("lays the page to the right of the focused panel", async () => {
        env.focused = "term";
        await createBesideFocused(CicdDef);
        expect(env.openPanelBeside).toHaveBeenCalledWith("term", CicdDef);
        expect(env.createBlock).not.toHaveBeenCalled();
    });

    it("inserts it where Wave puts a panel when none is focused or the focused one is not laid out", async () => {
        await createBesideFocused(CicdDef);
        env.focused = "gone";
        env.openPanelBeside = vi.fn(async () => null);
        await createBesideFocused(CicdDef);
        expect(env.createBlock).toHaveBeenCalledTimes(2);
        expect(env.createTab).not.toHaveBeenCalled();
    });
});
