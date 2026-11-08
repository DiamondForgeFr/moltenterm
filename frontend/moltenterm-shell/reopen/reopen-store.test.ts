// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of reopening (#512, #1744): panels and views are recorded in the order they close, and Cmd+Shift+T
// asks for the last one. The one closing order itself is kept by wavesrv (pkg/molten/reopen, route_test.go); these tests
// pin what the window sends and when.

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    mac: true,
    calls: [] as { command: string; data: any }[],
    toasts: [] as any[],
    handler: (async () => ({})) as (command: string, data: any) => Promise<any>,
}));

vi.mock("@/app/store/global", () => ({
    atoms: { workspaceId: { v: "ws1" }, staticTabId: { v: "tab1" } },
    getApi: () => ({ getHomeDir: () => "/home/me", switchWorkspace: () => {} }),
    globalStore: { get: (a: { v: string }) => a.v },
}));
vi.mock("@/app/store/wos", () => ({
    loadAndPinWaveObject: async () => ({ meta: {} }),
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
}));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: (command: string, data: any) => {
            app.calls.push({ command, data });
            return app.handler(command, data);
        },
    },
}));
vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: () => ({ treeState: { rootNode: null } }) }));
vi.mock("@/util/platformutil", () => ({ isMacOS: () => app.mac }));
vi.mock("../toast-store", () => ({ showToast: (toast: unknown) => app.toasts.push(toast) }));
vi.mock("../view360/carpet-reopen", () => ({ showReopenedPanel: () => "done" }));

import { recordingTabClose, recordPaneClose, reopenKeys, reopenLastClosed } from "./reopen-store";

const names = () => app.calls.map((c) => `${c.command}:${c.data.kind ?? ""}:${c.data.blockid ?? c.data.tabid ?? ""}`);

beforeEach(() => {
    app.mac = true;
    app.calls = [];
    app.toasts = [];
    app.handler = async () => ({});
});

describe("recording the closes, in the order they are made (#1744)", () => {
    it("records a panel, a view and a panel in the order they close, each before its close happens", async () => {
        const events: string[] = [];
        app.handler = async (command, data) => {
            events.push(`${command}:${data.kind}:${data.blockid ?? data.tabid}`);
            return { id: `id${events.length}` };
        };
        const closeView = async () => {
            events.push("view-closed");
            return true;
        };
        await recordPaneClose("p1");
        await recordingTabClose(closeView)("ws1", "v2", false);
        await recordPaneClose("p3");
        expect(events).toEqual([
            "moltenreopenrecord:pane:p1",
            "moltenreopenrecord:tab:v2",
            "view-closed",
            "moltenreopenrecord:pane:p3",
        ]);
    });

    it("sends the window's workspace and tab with a panel, and the live layout of the tab it closes in", async () => {
        await recordPaneClose("p1");
        expect(app.calls[0].data).toMatchObject({ kind: "pane", workspaceid: "ws1", tabid: "tab1", blockid: "p1" });
        expect(app.calls[0].data.root).toBeUndefined();
    });

    it("takes back the record of a view whose close was declined, so it is not reopened later", async () => {
        app.handler = async (command) => (command === "moltenreopenrecord" ? { id: "kept-by-mistake" } : {});
        const declined = await recordingTabClose(async () => false)("ws1", "v2", true);
        expect(declined).toBe(false);
        expect(app.calls.map((c) => c.command)).toEqual(["moltenreopenrecord", "moltenreopendrop"]);
        expect(app.calls[1].data).toEqual({ workspaceid: "ws1", id: "kept-by-mistake" });
    });

    it("records nothing for a close it cannot name", async () => {
        expect(await recordPaneClose("")).toBeNull();
        expect(app.calls).toEqual([]);
    });

    it("never lets a slow or failing record stop the close", async () => {
        app.handler = async () => {
            throw new Error("wavesrv is slow");
        };
        const closeView = vi.fn(async () => true);
        expect(await recordingTabClose(closeView)("ws1", "v2", false)).toBe(true);
        expect(closeView).toHaveBeenCalledTimes(1);
    });
});

describe("Cmd+Shift+T asks for the last close (#512, #1744)", () => {
    it("asks once for the workspace and the tab of the window, and says what came back", async () => {
        app.handler = async () => ({ reopened: true, kind: "tab", name: "api" });
        await reopenLastClosed();
        expect(names()).toEqual(["moltenreopenlast::tab1"]);
        expect(app.calls[0].data).toEqual({ workspaceid: "ws1", tabid: "tab1" });
        expect(app.toasts).toHaveLength(1);
        expect(app.toasts[0].title).toBe("Reopened the view “api”");
    });

    it("ignores a second press while the first is still running, then asks again once it is done", async () => {
        let release: (value: unknown) => void = null;
        app.handler = (command) =>
            command === "moltenreopenlast"
                ? new Promise((resolve) => {
                      release = resolve;
                  })
                : Promise.resolve({});
        const first = reopenLastClosed();
        await reopenLastClosed();
        expect(app.calls.filter((c) => c.command === "moltenreopenlast")).toHaveLength(1);
        release({ reopened: false });
        await first;
        app.handler = async () => ({ reopened: false });
        await reopenLastClosed();
        expect(app.calls.filter((c) => c.command === "moltenreopenlast")).toHaveLength(2);
        expect(app.toasts.map((t) => t.title)).toEqual(["Nothing to reopen", "Nothing to reopen"]);
    });

    it("says so when the last close could not come back, and stays usable", async () => {
        app.handler = async () => {
            throw new Error("no room");
        };
        await reopenLastClosed();
        expect(app.toasts[0]).toMatchObject({ kind: "error", title: "The last closed panel could not be reopened" });
        app.handler = async () => ({ reopened: false });
        await reopenLastClosed();
        expect(app.toasts[1].title).toBe("Nothing to reopen");
    });

    it("is Cmd+Shift+T on macOS, and also the browsers' Ctrl+Shift+T elsewhere", () => {
        app.mac = true;
        expect(reopenKeys()).toEqual(["Cmd:Shift:t"]);
        app.mac = false;
        expect(reopenKeys()).toEqual(["Cmd:Shift:t", "Ctrl:Shift:t"]);
    });
});
