// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The row's bookmark buttons are sized from their first render (#2560): the header shows them before the popover or the
// panel has ever opened, so neither their icons' size nor their styles may depend on the stylesheet those lazy modules
// load. This file imports only the buttons' module, as the header does.

import { readFileSync } from "node:fs";
import { Provider, createStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    const clientAtom = atom(() => null);
    return { ClientModel: { getInstance: () => ({ clientAtom, clientId: "c1" }) } };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom(() => null) }, globalStore: { get: () => null } };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (otype: string, oid: string) => `${otype}:${oid}` }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: async () => {} } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../contexts/context-store", () => ({ useContexts: () => [], getContexts: () => [] }));
vi.mock("../workspace-sources", () => ({ subscribeWorkspaceSources: () => () => {} }));

import { BookmarkAddButton, BookmarksPanelButton } from "./bookmark-buttons";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

function render(node: React.ReactElement) {
    return renderToStaticMarkup(<Provider store={createStore()}>{node}</Provider>);
}

function svgOf(html: string): { width: string; height: string; stroke: string } {
    const svg = html.match(/<svg[^>]*>/)?.[0] ?? "";
    return {
        width: svg.match(/\bwidth="([^"]+)"/)?.[1],
        height: svg.match(/\bheight="([^"]+)"/)?.[1],
        stroke: svg.match(/\bstroke-width="([^"]+)"/)?.[1],
    };
}

// The row's other Lucide icon: the Comment button, between Forward and Reload.
function commentIcon(): { size: string; stroke: string } {
    const tag = read("comment-button.tsx").match(/<MessageSquarePlus[^>]*\/>/)?.[0] ?? "";
    return { size: tag.match(/size=\{(\d+)\}/)?.[1], stroke: tag.match(/strokeWidth=\{(\d+)\}/)?.[1] };
}

describe("the row's bookmark buttons (#2560)", () => {
    const row = commentIcon();

    it("reads the row's icon size from the Comment button", () => {
        expect(row.size).toBe("14");
        expect(row.stroke).toBe("2");
    });

    it("draws the add icon at the row's size before any popover or panel has loaded", () => {
        const icon = svgOf(render(<BookmarkAddButton tabId="tab1" pageUrl="https://example.com/" onClick={() => {}} />));
        expect(icon).toEqual({ width: row.size, height: row.size, stroke: row.stroke });
    });

    it("draws the book icon at the row's size before any popover or panel has loaded", () => {
        const icon = svgOf(render(<BookmarksPanelButton open={false} onClick={() => {}} />));
        expect(icon).toEqual({ width: row.size, height: row.size, stroke: row.stroke });
    });

    it("loads the buttons' own styles with the buttons, not with the lazy popover and panel", () => {
        const source = read("bookmark-buttons.tsx");
        expect(source).toMatch(/^import "\.\/bookmark-buttons\.css";$/m);
        expect(source).not.toMatch(/^import [^;]*["']\.\/(bookmarks\.css|bookmark-parts|bookmarks-panel|bookmark-popover)["']/m);
        const css = read("bookmark-buttons.css");
        expect(css).toContain(".molten-bm-add-icon.is-saved");
        expect(css).toContain('.molten-bm-book[aria-pressed="true"]');
        const lazy = read("bookmarks.css");
        expect(lazy).not.toMatch(/\.molten-bm-(add-icon|book-icon|book\[)/);
    });
});
