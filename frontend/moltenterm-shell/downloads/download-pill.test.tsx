// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws" }) }, getApi: () => ({}) };
});
vi.mock("@/app/store/services", () => ({ ObjectService: {}, WorkspaceService: {} }));
vi.mock("@/app/store/tab-model", async () => {
    const { atom } = await import("jotai");
    return { activeTabIdAtom: atom("tab") };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { DownloadPill } from "./download-pill";
import { DownloadRecord } from "./downloads-model";
import { DownloadsModel } from "./downloads-store";

const model = DownloadsModel.getInstance();

function record(over: Partial<DownloadRecord> = {}): DownloadRecord {
    return {
        id: "a",
        url: "https://miroir.example.org/debian.iso",
        host: "miroir.example.org",
        name: "debian.iso",
        path: "/dl/debian.iso",
        mime: "",
        state: "progressing",
        received: 310,
        total: 1000,
        bytesPerSecond: 10,
        startedAt: 1,
        endedAt: 0,
        reason: "",
        executable: false,
        missing: false,
        agent: "",
        workspaceId: "ws",
        tabId: "tab",
        blockId: "panel-1",
        browserTabId: "bt",
        pageUrl: "https://miroir.example.org",
        pageTitle: "Miroir",
        ...over,
    };
}

function render(blockId: string, items: DownloadRecord[]) {
    globalStore.set(model.snapshotAtom, { items, folder: "/dl", askWhere: false });
    return renderToStaticMarkup(<DownloadPill blockId={blockId} />);
}

beforeEach(() => {
    globalStore.set(model.snapshotAtom, { items: [], folder: "", askWhere: false });
});

describe("the pill of the panel that started a download (FR-MC-019 AC9, #1992)", () => {
    it("is not there while nothing downloads", () => {
        expect(render("panel-1", [])).toBe("");
        expect(render("panel-1", [record({ state: "completed", endedAt: 5 })])).toBe("");
    });

    it("says what it is: a ring with the percentage, a name and a tooltip that names the file", () => {
        const html = render("panel-1", [record()]);
        expect(html).toContain('data-testid="download-pill"');
        expect(html).toContain('aria-label="Downloading: debian.iso"');
        expect(html).toContain('title="Downloading: debian.iso"');
        expect(html).toContain("31%");
        expect(html).toContain("<svg");
    });

    it("shows only in the panel the download started in", () => {
        expect(render("panel-2", [record()])).toBe("");
        expect(render("panel-1", [record({ blockId: "panel-2" })])).toBe("");
    });

    it("counts several downloads of one panel, and averages their ring", () => {
        const html = render("panel-1", [record({ id: "a" }), record({ id: "b", received: 690 })]);
        expect(html).toContain('aria-label="2 downloads in progress"');
        expect(html).toContain("50%");
    });

    it("has no percentage when the site gives no size, and counts a paused download as no ring", () => {
        const unknown = render("panel-1", [record({ total: 0 })]);
        expect(unknown).toContain('data-testid="download-pill"');
        expect(unknown).not.toContain("%");
        // A paused download still holds the pill: the file is not finished.
        expect(render("panel-1", [record({ state: "paused" })])).toContain('data-testid="download-pill"');
    });
});
