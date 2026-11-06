// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { DownloadOrigin } from "./downloads-model";
import { goToPage, goToView, loadOriginFacts, OriginIo, reopenPage } from "./downloads-origin";
import {
    canReopenPage,
    freshOpenPage,
    OpenPageFreshMs,
    OpenPageMetaKey,
    originState,
    reopenTarget,
    type OriginFacts,
} from "./downloads-origin-model";

const origin: DownloadOrigin = {
    workspaceId: "ws-origin",
    tabId: "tab-origin",
    blockId: "block-1",
    browserTabId: "bt-1",
    pageUrl: "https://example.com/files",
    pageTitle: "Files",
};

const open: OriginFacts = {
    workspace: { name: "MoltenTerm", activeTabId: "tab-shown" },
    view: { name: "Recherche", blockIds: ["block-1", "block-2"] },
};

describe("what a row says about where the download came from (#1992)", () => {
    it("leads to the page while its panel is still in its view", () => {
        expect(originState(origin, open, "ws-origin")).toEqual({
            kind: "page",
            workspaceName: "MoltenTerm",
            viewName: "Recherche",
            otherWorkspace: false,
            cta: "goto",
            toView: false,
        });
    });

    it("tells a page that was closed while its view is still there, and offers the view and the page again", () => {
        const closed: OriginFacts = { ...open, view: { name: "Recherche", blockIds: ["block-2"] } };
        expect(originState(origin, closed, "ws-origin")).toMatchObject({
            kind: "pageclosed",
            cta: "reopen",
            toView: true,
        });
    });

    it("tells a view that was closed too, and offers the page again in the workspace", () => {
        const gone: OriginFacts = { ...open, view: null };
        expect(originState(origin, gone, "ws-origin")).toMatchObject({
            kind: "viewclosed",
            cta: "reopen",
            toView: false,
        });
    });

    it("offers nothing when the origin workspace was deleted, and says so", () => {
        expect(originState(origin, { workspace: null, view: null }, "ws-origin")).toMatchObject({
            kind: "workspacegone",
            cta: "none",
            toView: false,
        });
    });

    it("names the origin workspace when it is not the one the developer is in", () => {
        expect(originState(origin, open, "ws-other")).toMatchObject({
            otherWorkspace: true,
            workspaceName: "MoltenTerm",
        });
        const gone: OriginFacts = { ...open, view: null };
        expect(originState(origin, gone, "ws-other")).toMatchObject({
            kind: "viewclosed",
            cta: "reopen",
            otherWorkspace: true,
        });
    });

    it("never offers a button that cannot work: no address to open, or nothing known", () => {
        const blob = { ...origin, pageUrl: "blob:https://example.com/x" };
        const closed: OriginFacts = { ...open, view: { name: "V", blockIds: [] } };
        expect(originState(blob, closed, "ws-origin")).toMatchObject({ kind: "pageclosed", cta: "none", toView: true });
        expect(originState(blob, { ...open, view: null }, "ws-origin")).toMatchObject({
            kind: "viewclosed",
            cta: "none",
        });
        expect(originState({ ...origin, workspaceId: "" }, open, "ws-origin").cta).toBe("none");
        expect(originState(origin, null, "ws-origin")).toMatchObject({ kind: "unknown", cta: "none" });
    });

    it("opens only web addresses again", () => {
        expect(canReopenPage("https://example.com/a")).toBe(true);
        expect(canReopenPage("http://localhost:3000")).toBe(true);
        expect(canReopenPage("javascript:alert(1)")).toBe(false);
        expect(canReopenPage("file:///etc/passwd")).toBe(false);
        expect(canReopenPage("")).toBe(false);
    });

    it("reopens in the page's own view when it exists, else in the view its workspace shows, never elsewhere", () => {
        expect(reopenTarget(origin, open)).toEqual({ workspaceId: "ws-origin", tabId: "tab-origin" });
        expect(reopenTarget(origin, { ...open, view: null })).toEqual({ workspaceId: "ws-origin", tabId: "tab-shown" });
        expect(reopenTarget(origin, { workspace: null, view: null })).toBeNull();
        expect(reopenTarget(origin, { workspace: { name: "x", activeTabId: "" }, view: null })).toBeNull();
        expect(reopenTarget(origin, null)).toBeNull();
    });

    it("accepts a fresh request to open a web page and ignores a stale, foreign or malformed one", () => {
        const now = 1_000_000;
        const url = "https://example.com/files";
        expect(freshOpenPage({ [OpenPageMetaKey]: { url, ts: now - 1000 } }, now)).toBe(url);
        expect(freshOpenPage({ [OpenPageMetaKey]: { url, ts: now - OpenPageFreshMs - 1 } }, now)).toBeNull();
        expect(freshOpenPage({ [OpenPageMetaKey]: { url: "file:///x", ts: now } }, now)).toBeNull();
        expect(freshOpenPage({ [OpenPageMetaKey]: "no" }, now)).toBeNull();
        expect(freshOpenPage({}, now)).toBeNull();
    });
});

function makeIo(over: Partial<OriginIo> = {}, here = { workspaceId: "ws-origin", tabId: "tab-origin" }) {
    const calls: string[] = [];
    const metas: { tabId: string; meta: Record<string, unknown> }[] = [];
    const io: OriginIo = {
        getWorkspace: async () =>
            ({
                oid: "ws-origin",
                name: "MoltenTerm",
                tabids: ["tab-origin", "tab-shown"],
                activetabid: "tab-shown",
            }) as Workspace,
        getTab: async () => ({ oid: "tab-origin", name: "Recherche", blockids: ["block-1"] }) as Tab,
        setTabMeta: async (tabId, meta) => {
            calls.push(`meta ${tabId}`);
            metas.push({ tabId, meta });
        },
        setWorkspaceActiveTab: async (workspaceId, tabId) => {
            calls.push(`active ${workspaceId} ${tabId}`);
        },
        switchWorkspace: (workspaceId) => {
            calls.push(`switch ${workspaceId}`);
        },
        setActiveTab: (tabId) => {
            calls.push(`tab ${tabId}`);
        },
        here: () => here,
        now: () => 5000,
        ...over,
    };
    return { io, calls, metas };
}

describe("reading where a download came from", () => {
    it("reads the workspace, the view and the panels it still holds", async () => {
        const { io } = makeIo();
        expect(await loadOriginFacts(origin, io)).toEqual({
            workspace: { name: "MoltenTerm", activeTabId: "tab-shown" },
            view: { name: "Recherche", blockIds: ["block-1"] },
        });
    });

    it("finds a deleted workspace, and a view that is no longer one of its views", async () => {
        expect(await loadOriginFacts(origin, makeIo({ getWorkspace: async () => null }).io)).toEqual({
            workspace: null,
            view: null,
        });
        const noView = makeIo({
            getWorkspace: async () =>
                ({
                    oid: "ws-origin",
                    name: "MoltenTerm",
                    tabids: ["tab-shown"],
                    activetabid: "tab-shown",
                }) as Workspace,
        });
        expect((await loadOriginFacts(origin, noView.io)).view).toBeNull();
        const noObject = makeIo({ getTab: async () => null });
        expect((await loadOriginFacts(origin, noObject.io)).view).toBeNull();
    });

    it("claims nothing when wavesrv cannot answer", async () => {
        const failing = makeIo({
            getWorkspace: async () => {
                throw new Error("offline");
            },
        });
        expect(await loadOriginFacts(origin, failing.io)).toBeNull();
        expect(await loadOriginFacts({ ...origin, tabId: "" }, makeIo().io)).toBeNull();
    });
});

describe("going to the page (open page, #1992)", () => {
    it("asks the view's renderer to focus the panel and show the page, which also reveals it on the 360 carpet", async () => {
        const { io, calls, metas } = makeIo();
        await goToPage(origin, io);
        expect(metas).toEqual([
            {
                tabId: "tab-origin",
                meta: { "molten:focusblock": { blockid: "block-1", ts: 5000, browsertabid: "bt-1" } },
            },
        ]);
        expect(calls).toEqual(["meta tab-origin"]);
    });

    it("switches to the view when it is another one of this workspace, the request left first", async () => {
        const { io, calls } = makeIo({}, { workspaceId: "ws-origin", tabId: "tab-shown" });
        await goToPage(origin, io);
        expect(calls).toEqual(["meta tab-origin", "tab tab-origin"]);
    });

    it("switches workspace with that view shown when the page lives in another workspace", async () => {
        const { io, calls } = makeIo({}, { workspaceId: "ws-current", tabId: "tab-current" });
        await goToPage(origin, io);
        expect(calls).toEqual(["meta tab-origin", "active ws-origin tab-origin", "switch ws-origin"]);
    });
});

describe("going to the view (page closed, view still there)", () => {
    it("takes the window to the view without asking for a panel", async () => {
        const { io, calls, metas } = makeIo({}, { workspaceId: "ws-origin", tabId: "tab-shown" });
        await goToView(origin, io);
        expect(metas).toEqual([]);
        expect(calls).toEqual(["tab tab-origin"]);
    });
});

describe("reopening the page: always in the origin workspace (#1992)", () => {
    it("with the origin workspace different from the current one: switches to it first, then opens the page in its view", async () => {
        const { io, calls, metas } = makeIo({}, { workspaceId: "ws-current", tabId: "tab-current" });
        const facts = await loadOriginFacts(origin, io);
        expect(await reopenPage(origin, facts, io)).toBe(true);
        expect(calls).toEqual(["meta tab-origin", "active ws-origin tab-origin", "switch ws-origin"]);
        expect(metas).toEqual([
            { tabId: "tab-origin", meta: { "molten:openpage": { url: "https://example.com/files", ts: 5000 } } },
        ]);
        // Nothing was asked of the workspace the developer is in.
        expect(calls.some((c) => c.includes("ws-current") || c.includes("tab-current"))).toBe(false);
    });

    it("when the origin view is closed: opens it in a new browser panel of the view the origin workspace shows", async () => {
        const { io, calls, metas } = makeIo(
            {
                getWorkspace: async () =>
                    ({
                        oid: "ws-origin",
                        name: "MoltenTerm",
                        tabids: ["tab-shown"],
                        activetabid: "tab-shown",
                    }) as Workspace,
            },
            { workspaceId: "ws-current", tabId: "tab-current" }
        );
        const facts = await loadOriginFacts(origin, io);
        expect(await reopenPage(origin, facts, io)).toBe(true);
        expect(metas[0].tabId).toBe("tab-shown");
        expect(calls).toEqual(["meta tab-shown", "active ws-origin tab-shown", "switch ws-origin"]);
    });

    it("with the origin workspace deleted: opens nothing, anywhere", async () => {
        const { io, calls, metas } = makeIo(
            { getWorkspace: async () => null },
            { workspaceId: "ws-current", tabId: "tab-current" }
        );
        const facts = await loadOriginFacts(origin, io);
        expect(await reopenPage(origin, facts, io)).toBe(false);
        expect(calls).toEqual([]);
        expect(metas).toEqual([]);
    });

    it("in the workspace the developer is already in, only the view changes", async () => {
        const { io, calls } = makeIo({}, { workspaceId: "ws-origin", tabId: "tab-shown" });
        const facts = await loadOriginFacts(origin, io);
        expect(await reopenPage(origin, facts, vi.mocked(io) as OriginIo)).toBe(true);
        expect(calls).toEqual(["meta tab-origin", "tab tab-origin"]);
    });
});
