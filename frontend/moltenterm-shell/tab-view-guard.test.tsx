// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

import { atoms, initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider, useAtomValue } from "jotai";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabViewBoundary, TabViewGuard, TabViewPending } from "./tab-view-guard";
import { pinTabWorkspace } from "./tab-workspace";

const TabId = "tab-g";

// What workspace.tsx:117 did with a null workspace: `<TabBar key={ws.oid} />`.
function WorkspaceLike() {
    const ws = useAtomValue(atoms.workspace);
    return <div data-ws={ws.oid} />;
}

function render() {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <TabViewGuard>
                <WorkspaceLike />
            </TabViewGuard>
        </Provider>
    );
}

function update(obj: WaveObj) {
    WOS.updateWaveObject({ updatetype: "update", otype: obj.otype, oid: obj.oid, obj });
}

describe("TabViewGuard (FR-PERF-001)", () => {
    beforeAll(() => {
        initGlobalAtoms({ tabId: TabId, windowId: "win-g", clientId: "c", platform: "darwin" } as any);
        update({ otype: "window", oid: "win-g", version: 1, workspaceid: "ws-g" } as WaveWindow);
    });

    it("a view reading a null workspace throws without the guard (the crash of #445 bug A)", () => {
        expect(() =>
            renderToStaticMarkup(
                <Provider store={globalStore}>
                    <WorkspaceLike />
                </Provider>
            )
        ).toThrow(/reading 'oid'/);
    });

    it("shows the pending state while the workspace is not loaded", () => {
        update({ otype: "tab", oid: TabId, version: 1, name: "T", blockids: [] } as Tab);
        const html = render();
        // The visible form of #450: a quiet progress line, not an empty surface.
        expect(html).toContain('data-molten-view-pending="loading"');
        expect(html).toContain("molten-view-pending-line");
        expect(html).toContain("Opening…");
    });

    it("renders the view once its workspace and tab are there", () => {
        update({ otype: "workspace", oid: "ws-g", version: 1, tabids: [TabId] } as Workspace);
        pinTabWorkspace("ws-g");
        expect(render()).toBe('<div data-ws="ws-g"></div>');
    });

    it("shows the pending state when its tab is deleted", () => {
        WOS.updateWaveObject({ updatetype: "delete", otype: "tab", oid: TabId });
        expect(render()).toContain("data-molten-view-pending");
    });

    it("shows the pending state when its workspace is deleted", () => {
        update({ otype: "tab", oid: TabId, version: 2, name: "T", blockids: [] } as Tab);
        WOS.updateWaveObject({ updatetype: "delete", otype: "workspace", oid: "ws-g" });
        expect(render()).toContain("data-molten-view-pending");
    });
});

describe("TabViewBoundary", () => {
    function makeBoundary(resetKey: string) {
        const b = new TabViewBoundary({ resetKey, children: <span /> });
        b.setState = (s: any) => {
            b.state = { ...b.state, ...s };
        };
        return b;
    }

    it("turns a render error into the pending state instead of unmounting the root", () => {
        const b = makeBoundary("1");
        b.state = TabViewBoundary.getDerivedStateFromError(new TypeError("x"));
        const out = b.render();
        expect(isValidElement(out) && out.type).toBe(TabViewPending);
    });

    it("renders the view again on the next update, and only then", () => {
        const b = makeBoundary("1");
        b.state = TabViewBoundary.getDerivedStateFromError(new TypeError("x"));
        b.componentDidUpdate({ resetKey: "1", children: null });
        expect(b.state.error).not.toBeNull();
        (b as any).props = { resetKey: "2", children: <span /> };
        b.componentDidUpdate({ resetKey: "1", children: null });
        expect(b.state.error).toBeNull();
    });

    it("reports the error", () => {
        const onError = vi.fn();
        const b = new TabViewBoundary({ resetKey: "1", onError, children: null });
        b.componentDidCatch(new Error("boom"));
        expect(onError).toHaveBeenCalledOnce();
    });
});
