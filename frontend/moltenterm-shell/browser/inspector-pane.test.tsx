// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const SizeSetting = vi.hoisted(() => ({ atom: null as any }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    SizeSetting.atom = atom(0.3);
    return { getSettingsKeyAtom: () => SizeSetting.atom, getApi: () => ({}) };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetConfigCommand: async () => {} } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { BrowserInspectorModel } from "./browser-inspector";
import { InspectorPane, InspectorPaneHost } from "./inspector-pane";

function host(): InspectorPaneHost {
    return {
        inspector: new BrowserInspectorModel(),
        pageIdOf: () => 7,
        closeInspector: () => {},
        openPageDevTools: () => {},
        inspectorFailed: () => {},
    };
}

describe("the docked tools' pane (FR-BRW-022 AC2, DS-BRW-027)", () => {
    it("takes the remembered share of the panel, under a divider the keyboard can move", () => {
        const html = renderToStaticMarkup(<InspectorPane host={host()} tabId="t1" entry={{ nonce: 1 }} active shown />);
        expect(html).toContain("height:30%");
        expect(html).toMatch(/role="separator"[^>]*aria-orientation="horizontal"/);
        expect(html).toContain('aria-label="Resize the developer tools"');
        expect(html).toContain('aria-valuemin="15"');
        expect(html).toContain('aria-valuemax="85"');
        expect(html).toContain('aria-valuenow="30"');
        expect(html).toContain('tabindex="0"');
    });

    it("names the tools and offers the separate window and Close with the platform's keys", () => {
        const html = renderToStaticMarkup(<InspectorPane host={host()} tabId="t1" entry={{ nonce: 1 }} active shown />);
        expect(html).toContain("Developer tools");
        expect(html).toContain('title="Open in a separate window"');
        expect(html).toMatch(/title="Close the developer tools \((⌥⌘I|Ctrl\+Shift\+I)\)"/);
        expect(html).toContain('aria-label="Close inspector"');
    });

    it("keeps no room in the panel for a page that is not the shown one", () => {
        const html = renderToStaticMarkup(
            <InspectorPane host={host()} tabId="t2" entry={{ nonce: 1 }} active={false} shown />
        );
        expect(html).toMatch(/class="molten-browser-inspector [^"]*hidden/);
    });
});
