// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws-origin" }) }, getApi: () => ({}) };
});
vi.mock("@/app/store/services", () => ({ ObjectService: {}, WorkspaceService: {} }));
vi.mock("@/app/store/tab-model", async () => {
    const { atom } = await import("jotai");
    return { activeTabIdAtom: atom("tab-origin") };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: () => ({}),
}));

import { globalStore } from "@/app/store/jotaiStore";
import { DownloadRecord } from "./downloads-model";
import { OriginState } from "./downloads-origin-model";
import { DownloadsModel } from "./downloads-store";
import { DownloadRow, DownloadsList } from "./downloads-view";

const Now = Date.now();

function record(over: Partial<DownloadRecord> = {}): DownloadRecord {
    return {
        id: "a",
        url: "https://compta.example.com/rapport-q3.pdf",
        host: "compta.example.com",
        name: "rapport-q3.pdf",
        path: "/dl/rapport-q3.pdf",
        mime: "application/pdf",
        state: "completed",
        received: 4_200_000,
        total: 4_200_000,
        bytesPerSecond: 0,
        startedAt: Now - 120_000,
        endedAt: Now - 100_000,
        reason: "",
        executable: false,
        missing: false,
        agent: "",
        workspaceId: "ws-origin",
        tabId: "tab-origin",
        blockId: "block-1",
        browserTabId: "bt-1",
        pageUrl: "https://compta.example.com/files",
        pageTitle: "Compta",
        ...over,
    };
}

const model = DownloadsModel.getInstance();

function show(items: DownloadRecord[], origins: Record<string, OriginState> = {}, errors: Record<string, string> = {}) {
    globalStore.set(model.snapshotAtom, { items, folder: "/dl", askWhere: false });
    globalStore.set(model.originsAtom, origins);
    globalStore.set(model.errorsAtom, errors);
    return renderToStaticMarkup(<DownloadsList />);
}

const page: OriginState = {
    kind: "page",
    workspaceName: "MoltenTerm",
    viewName: "Recherche",
    otherWorkspace: false,
    cta: "goto",
    toView: false,
};

beforeEach(() => {
    globalStore.set(model.snapshotAtom, { items: [], folder: "", askWhere: false });
    globalStore.set(model.originsAtom, {});
    globalStore.set(model.errorsAtom, {});
});

describe("the Downloads section (FR-MC-019 AC7, AC8)", () => {
    it("says what it is when there is nothing, and offers the folder", () => {
        const html = show([]);
        expect(html).toContain('data-testid="downloads-empty"');
        expect(html).toContain("No downloads.");
        expect(html).toContain("Clearing the list never deletes the files.");
        expect(html).toContain('data-testid="downloads-open-folder"');
    });

    it("shows a download in progress with its bar, size, speed and time left, Pause and Cancel", () => {
        const html = show([
            record({
                id: "run",
                name: "debian.iso",
                state: "progressing",
                received: 412_000_000,
                total: 1_800_000_000,
                bytesPerSecond: 14_200_000,
                endedAt: 0,
            }),
        ]);
        expect(html).toContain('data-state="progressing"');
        expect(html).toContain('role="progressbar"');
        expect(html).toContain('aria-valuenow="22"');
        expect(html).toContain("412\u00a0MB of 1.8\u00a0GB");
        expect(html).toContain("14.2\u00a0MB/s");
        expect(html).toContain("about 1 min 38 s left");
        expect(html).toContain('data-testid="download-pause"');
        expect(html).toContain('data-testid="download-cancel"');
        expect(html).not.toContain('data-testid="download-open"');
        expect(html).not.toContain('data-testid="download-remove"');
    });

    it("invents no percentage and no time left when the site gives no size", () => {
        const html = show([
            record({
                id: "u",
                state: "progressing",
                received: 41_000_000,
                total: 0,
                bytesPerSecond: 6_300_000,
                endedAt: 0,
            }),
        ]);
        expect(html).toContain("41\u00a0MB received");
        expect(html).not.toContain("aria-valuenow");
        expect(html).not.toContain("left");
    });

    it("shows a paused download with Resume, and no speed", () => {
        const html = show([
            record({
                id: "p",
                state: "paused",
                received: 1_100_000_000,
                total: 2_400_000_000,
                bytesPerSecond: 0,
                endedAt: 0,
            }),
        ]);
        expect(html).toContain('data-testid="download-resume"');
        expect(html).not.toContain('data-testid="download-pause"');
        expect(html).toContain("paused");
        expect(html).not.toContain("MB/s");
    });

    it("shows a finished download with Open, Show in folder, Copy link and Remove from list", () => {
        const html = show([record()], { a: page });
        for (const id of ["download-open", "download-reveal", "download-copy", "download-remove"]) {
            expect(html, id).toContain(`data-testid="${id}"`);
        }
        expect(html).not.toContain('data-testid="download-retry"');
        expect(html).toContain("4.2\u00a0MB");
    });

    it("shows an interrupted download with its reason and Retry, never Open", () => {
        const html = show([
            record({
                id: "i",
                state: "interrupted",
                reason: "connection",
                received: 3_700_000_000,
                total: 6_100_000_000,
                endedAt: Now - 1000,
            }),
        ]);
        expect(html).toContain('data-testid="download-retry"');
        expect(html).toContain("The connection was lost at 60%");
        expect(html).not.toContain('data-testid="download-open"');
        expect(html).toContain("Interrupted");
    });

    it("draws no bar for an interruption with nothing received: there is nothing to measure", () => {
        const none = show([
            record({ id: "n", state: "interrupted", reason: "server", received: 0, total: 0, endedAt: Now }),
        ]);
        expect(none).not.toContain('role="progressbar"');
        expect(none).toContain("The site did not send the file");
    });

    it("shows a cancelled download with Retry", () => {
        const html = show([record({ id: "c", state: "cancelled", received: 10, total: 100 })]);
        expect(html).toContain('data-testid="download-retry"');
        expect(html).toContain("Cancelled");
    });

    it("shows a file that was moved or deleted as such: Download again instead of Open and Show", () => {
        const html = show([record({ id: "m", missing: true })]);
        expect(html).toContain('data-missing="true"');
        expect(html).toContain("File moved or deleted");
        expect(html).toContain('data-testid="download-redownload"');
        expect(html).not.toContain('data-testid="download-open"');
        expect(html).not.toContain('data-testid="download-reveal"');
        expect(html).toContain('data-testid="download-remove"');
    });

    it("marks a program, and names the agent that started a download", () => {
        const html = show([
            record({ id: "x", name: "setup.exe", executable: true }),
            record({ id: "ag", name: "data.csv", agent: "Jérôme" }),
        ]);
        expect(html).toContain('data-testid="download-program"');
        expect(html).toContain("Started by Jérôme");
        expect(html).toContain('data-testid="download-agent"');
    });

    it("shows what the last action answered, in words", () => {
        const html = show([record()], {}, { a: "missing" });
        expect(html).toContain('data-testid="download-error"');
        expect(html).toContain("The file was moved or deleted.");
    });

    it("groups what runs first, then the history by day, and clears only when something is over", () => {
        const html = show([
            record({ id: "run", state: "progressing", total: 100, received: 10, endedAt: 0 }),
            record({ id: "done" }),
        ]);
        expect(html.indexOf("In progress")).toBeLessThan(html.indexOf("Today"));
        expect(html).toContain('data-testid="downloads-clear"');
        expect(html).toContain("Files are never deleted");
        const onlyRunning = show([record({ id: "run", state: "progressing", total: 100, received: 10, endedAt: 0 })]);
        expect(onlyRunning).toMatch(
            /data-testid="downloads-clear"[^>]*disabled|disabled=""[^>]*data-testid="downloads-clear"/
        );
    });
});

describe("opening a program asks first, in the entry (FR-MC-019 AC8)", () => {
    const base = {
        record: record({ id: "x", name: "setup.exe", executable: true, host: "outils.example.net" }),
        origin: page,
        error: "",
        now: Now,
        highlighted: false,
        onConfirming: () => {},
        onLeave: () => {},
    };

    it("shows the question in the entry, with Cancel first and focused, never a native dialog", () => {
        const html = renderToStaticMarkup(<DownloadRow {...base} confirming={true} />);
        expect(html).toContain('data-testid="download-confirm"');
        expect(html).toContain("Open “setup.exe”?");
        expect(html).toContain("outils.example.net");
        const cancel = html.indexOf('data-testid="download-confirm-cancel"');
        const open = html.indexOf('data-testid="download-confirm-open"');
        expect(cancel).toBeGreaterThan(-1);
        expect(cancel).toBeLessThan(open);
        expect(html).toMatch(
            /autofocus[^>]*data-testid="download-confirm-cancel"|data-testid="download-confirm-cancel"[^>]*autofocus/i
        );
        // The row's own actions give way to the question.
        expect(html).not.toContain('data-testid="download-open"');
    });

    it("asks nothing until Open is clicked", () => {
        const html = renderToStaticMarkup(<DownloadRow {...base} confirming={false} />);
        expect(html).not.toContain('data-testid="download-confirm"');
        expect(html).toContain('data-testid="download-open"');
    });
});

describe("the way back to the page (#1992)", () => {
    function originHtml(origin: OriginState, over: Partial<DownloadRecord> = {}) {
        return show([record(over)], { a: origin });
    }

    it("goes to the page while it is open, and says which view it is in", () => {
        const html = originHtml(page);
        expect(html).toContain('data-testid="download-goto"');
        expect(html).toContain("Go to the page");
        expect(html).toContain("compta.example.com · in Recherche");
        expect(html).not.toContain('data-testid="download-reopen"');
    });

    it("tells a page that was closed while its view is there, and offers to reopen it or to go to the view", () => {
        const html = originHtml({
            kind: "pageclosed",
            workspaceName: "MoltenTerm",
            viewName: "Recherche",
            otherWorkspace: false,
            cta: "reopen",
            toView: true,
        });
        expect(html).toContain("Original page closed: Compta");
        expect(html).toContain('data-testid="download-reopen"');
        expect(html).toContain("Reopen the page");
        expect(html).toContain('data-testid="download-toview"');
        expect(html).not.toContain('data-testid="download-goto"');
    });

    it("tells a view that was closed too, and reopens the page", () => {
        const html = originHtml({
            kind: "viewclosed",
            workspaceName: "MoltenTerm",
            viewName: "",
            otherWorkspace: false,
            cta: "reopen",
            toView: false,
        });
        expect(html).toContain("Original view closed: Compta");
        expect(html).toContain('data-testid="download-reopen"');
        expect(html).not.toContain('data-testid="download-toview"');
    });

    it("names the origin workspace when it is not the one the developer is in, on the row and the tooltip", () => {
        const html = originHtml({
            kind: "viewclosed",
            workspaceName: "MoltenTerm",
            viewName: "",
            otherWorkspace: true,
            cta: "reopen",
            toView: false,
        });
        expect(html).toContain("in MoltenTerm");
        expect(html).toContain("Reopen in MoltenTerm");
        expect(html).toContain("Reopen the page in the workspace “MoltenTerm”");
    });

    it("puts the origin text on its own line and every call to action together on one line beneath it", () => {
        const both = originHtml({
            kind: "pageclosed",
            workspaceName: "MoltenTerm",
            viewName: "Recherche",
            otherWorkspace: true,
            cta: "reopen",
            toView: true,
        });
        const text = both.indexOf('data-testid="download-origin-text"');
        const actions = both.indexOf('data-testid="download-origin-actions"');
        expect(text).toBeGreaterThan(-1);
        expect(actions).toBeGreaterThan(text);
        const group = both.slice(actions, both.indexOf("</div>", actions));
        expect(group).toContain('data-testid="download-reopen"');
        expect(group).toContain('data-testid="download-toview"');
        expect(both.slice(text, actions)).not.toContain("<button");
        const groupTag = both.slice(both.lastIndexOf("<div", actions), actions);
        expect(groupTag).toContain("flex-nowrap");
        expect(groupTag).not.toContain("flex-wrap ");

        const single = originHtml(page);
        expect(single.slice(single.indexOf('data-testid="download-origin-actions"'))).toContain("download-goto");
    });

    it("draws no group of actions when the row has none", () => {
        const html = originHtml({
            kind: "workspacegone",
            workspaceName: "",
            viewName: "",
            otherWorkspace: false,
            cta: "none",
            toView: false,
        });
        expect(html).toContain('data-testid="download-origin-text"');
        expect(html).not.toContain('data-testid="download-origin-actions"');
    });

    it("offers nothing when the origin workspace was deleted, and says so", () => {
        const html = originHtml({
            kind: "workspacegone",
            workspaceName: "",
            viewName: "",
            otherWorkspace: false,
            cta: "none",
            toView: false,
        });
        expect(html).toContain("Original workspace deleted");
        expect(html).not.toContain('data-testid="download-goto"');
        expect(html).not.toContain('data-testid="download-reopen"');
        expect(html).not.toContain('data-testid="download-toview"');
    });

    it("keeps the download itself whatever happens to its page: its actions do not depend on the origin", () => {
        const html = originHtml(
            {
                kind: "workspacegone",
                workspaceName: "",
                viewName: "",
                otherWorkspace: false,
                cta: "none",
                toView: false,
            },
            { state: "progressing", total: 100, received: 5, endedAt: 0 }
        );
        expect(html).toContain('data-testid="download-pause"');
        expect(html).toContain('data-testid="download-cancel"');
    });
});
