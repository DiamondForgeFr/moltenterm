// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
    api: { onPending: null as (state: any) => void, actions: [] as string[] },
}));

vi.mock("@/app/store/global", async () => {
    const { globalStore } = await import("@/app/store/jotaiStore");
    return {
        globalStore,
        getApi: () => ({
            onMoltentermViewPending: (callback: (state: any) => void) => {
                api.onPending = callback;
            },
            moltentermViewPendingAction: (action: string) => {
                api.actions.push(action);
            },
        }),
    };
});

import { PendingSurface, ViewPendingModel, ViewPendingOverlay } from "./view-pending";

function renderOverlay() {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <ViewPendingOverlay />
        </Provider>
    );
}

describe("pending state (FR-PERF-004, DS-PERF-005)", () => {
    beforeEach(() => {
        ViewPendingModel.resetInstance();
        api.onPending = null;
        api.actions = [];
    });

    it("draws nothing until the main process sends a pending state", () => {
        expect(renderOverlay()).toBe("");
        expect(api.onPending).not.toBeNull();
    });

    it("names the workspace over a quiet progress line, over the panels only", () => {
        renderOverlay();
        api.onPending({ phase: "loading", workspaceName: "Client A" });
        const html = renderOverlay();
        expect(html).toContain("absolute inset-0");
        expect(html).toContain("bg-background");
        expect(html).toMatch(/font-semibold[^"]*"[^>]*>Client A</);
        expect(html).toContain("molten-view-pending-line");
        expect(html).toContain('role="status"');
        expect(html).toContain("Opening…");
        expect(html).not.toContain("Reload");
    });

    it("says it is still opening while it retries", () => {
        renderOverlay();
        api.onPending({ phase: "retrying", workspaceName: "Client A" });
        expect(renderOverlay()).toContain("Still opening. This computer is busy.");
    });

    it("offers Reload and Dismiss after the second failure", () => {
        renderOverlay();
        api.onPending({ phase: "failed", workspaceName: "Client A" });
        const html = renderOverlay();
        expect(html).toContain("Client A did not open");
        expect(html).toContain('data-testid="view-pending-reload"');
        expect(html).toContain("molten-btn");
        expect(html).toContain('data-testid="view-pending-dismiss"');
        expect(html).not.toContain("molten-view-pending-line");
    });

    it("Reload and Dismiss go to the main process; Dismiss also hides it at once", () => {
        renderOverlay();
        api.onPending({ phase: "failed", workspaceName: "Client A" });
        const model = ViewPendingModel.getInstance();
        model.reload();
        expect(api.actions).toEqual(["reload"]);
        model.dismiss();
        expect(api.actions).toEqual(["reload", "dismiss"]);
        expect(renderOverlay()).toBe("");
    });

    it("goes away when the main process clears it", () => {
        renderOverlay();
        api.onPending({ phase: "loading", workspaceName: "Client A" });
        api.onPending(null);
        expect(renderOverlay()).toBe("");
    });

    it("the surface without a name (a tab view's own pending state) keeps the line", () => {
        const html = renderToStaticMarkup(<PendingSurface phase="loading" />);
        expect(html).toContain("molten-view-pending-line");
        expect(html).not.toContain("font-semibold");
    });
});
