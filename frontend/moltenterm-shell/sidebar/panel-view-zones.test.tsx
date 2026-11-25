// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the sidebar draws while a panel is dragged over it (FR-SHELL-079, FR-SHELL-080, #2548): every section a drop can
// land on lit on its own, the one under the pointer more, a sentence that says where the view goes, and a mark at the
// place it takes. The sidebar's own drags are unchanged.

import { ClientModel } from "@/app/store/client-model";
import { atoms, globalStore, WOS } from "@/app/store/global";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { atom, Provider } from "jotai";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { PanelHit } from "./panel-view-model";
import { freshViewsAtom, panelViewDragAtom } from "./panel-view-store";
import { panelSideClass, useFreshClass, usePanelZone } from "./panel-view-zones";
import { sidebarDragAtom } from "./sidebar-drag";
import { OtherProjectZones, TemporaryViews } from "./workspace-sidebar";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c-zones", platform: "darwin" } as any);
    ClientModel.getInstance().initialize("c-zones");
    WOS.updateWaveObject({
        updatetype: "update",
        otype: "client",
        oid: "c-zones",
        obj: { otype: "client", oid: "c-zones", version: 1, meta: {} },
    } as any);
});

afterEach(() => {
    globalStore.set(panelViewDragAtom, null);
    globalStore.set(sidebarDragAtom, null);
    globalStore.set(freshViewsAtom, []);
});

const env = {
    getSettingsKeyAtom: () => atom(null),
    atoms,
    wos: WOS,
    showContextMenu: () => {},
};

function dragOver(hit: PanelHit) {
    globalStore.set(panelViewDragAtom, { blockId: "block-1", hit });
}

// The window's store, as the app gives it to every component.
function inStore(node: React.ReactNode): string {
    return renderToStaticMarkup(<Provider store={globalStore}>{node}</Provider>);
}

function renderList(ids: string[]): string {
    return inStore(
        <WaveEnvContext.Provider value={env as any}>
            <TemporaryViews ids={ids} activeTabId={null} asideRef={createRef<HTMLElement>()} />
        </WaveEnvContext.Provider>
    );
}

// The part of the list's markup that belongs to one row.
function rowOf(html: string, tabId: string): string {
    const start = html.indexOf(`data-tab-id="${tabId}"`);
    const next = html.indexOf('data-testid="sidebar-view-row"', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
}

describe("the Views list while a panel is dragged over the sidebar", () => {
    it("is drawn as it always is when no panel is dragged", () => {
        const html = renderList(["tab-x", "tab-y"]);
        expect(html).not.toContain("is-panel");
        expect(html).toContain('data-cap="Unpin it"');
    });

    it("is lit as a drop zone with the sentence saying where the view goes", () => {
        dragOver(null);
        const html = renderList(["tab-x", "tab-y"]);
        expect(html).toMatch(/class="[^"]*mt-sb-zone[^"]*is-target[^"]*is-panel/);
        expect(html).not.toContain("is-over");
        expect(html).toContain('data-cap="New view in Views"');
    });

    it("is lit the more under the pointer", () => {
        dragOver({ zone: "temporary", key: "tab:tab-y", before: "tab-y" });
        expect(renderList(["tab-x", "tab-y"])).toMatch(/class="[^"]*is-over/);
    });

    it("keeps its own sentence over a folder's row, which rings with its own", () => {
        dragOver({ zone: "temporary", folderId: "f1", before: null });
        const html = renderList(["tab-x", "tab-y"]);
        expect(html).toContain('data-cap="New view in Views"');
        expect(html).not.toContain("in the folder");
        function Probe() {
            const zone = usePanelZone("temporary");
            return <span data-zone={zone.caption} data-folder={zone.folderCaption} />;
        }
        const probe = inStore(<Probe />);
        expect(probe).toContain('data-zone="New view in Views"');
        expect(probe).toMatch(/data-folder="New view in the folder /);
    });

    it("is lit while the pointer is on another zone, without the more", () => {
        dragOver({ zone: "top", key: "g1", after: false, before: "g1" });
        const html = renderList(["tab-x", "tab-y"]);
        expect(html).toContain("is-panel");
        expect(html).not.toContain("is-over");
    });

    it("marks the place with the bar before the row the view lands before, and no other", () => {
        dragOver({ zone: "temporary", key: "tab:tab-y", before: "tab-y" });
        const html = renderList(["tab-x", "tab-y", "tab-z"]);
        expect(rowOf(html, "tab-y")).toContain("h-[2px]");
        expect(rowOf(html, "tab-x")).not.toContain("h-[2px]");
        expect(rowOf(html, "tab-z")).not.toContain("h-[2px]");
        expect(html).not.toContain("-bottom-px");
    });

    it("marks the end of the list with the bar after the last row", () => {
        dragOver({ zone: "temporary", key: null, before: null });
        const html = renderList(["tab-x", "tab-y"]);
        expect(html).toContain("-bottom-px");
        expect(rowOf(html, "tab-y")).not.toContain('h-[2px] rounded-full bg-accent" />');
    });

    it("keeps its folders' ring and its drag's own marks for the sidebar's drags", () => {
        globalStore.set(sidebarDragAtom, {
            kind: "row",
            id: "tab-x",
            zone: "tiles",
            key: null,
            after: false,
            pinnable: true,
        });
        expect(renderList(["tab-x", "tab-y"])).not.toContain("is-panel");
    });
});

describe("the zones of the top row and the tiles", () => {
    function probe(zone: "top" | "tiles" | "temporary") {
        let seen: ReturnType<typeof usePanelZone> = null;
        function Probe() {
            seen = usePanelZone(zone);
            return null;
        }
        inStore(<Probe />);
        return seen;
    }

    it("are lit by no drag when no panel is dragged", () => {
        expect(probe("top")).toMatchObject({ active: false, over: false, caption: "" });
    });

    it("are each lit, the one under the pointer more, each with its own sentence", () => {
        dragOver({ zone: "tiles", key: "ta", after: false, before: "ta" });
        const top = probe("top");
        const tiles = probe("tiles");
        expect(top).toMatchObject({ active: true, over: false });
        expect(tiles).toMatchObject({ active: true, over: true });
        expect(top.caption).toMatch(/^New view pinned in /);
        expect(tiles.caption).toMatch(/^New view in the workspace /);
    });

    it("mark the side of the block the view lands on, as a reorder does", () => {
        dragOver({ zone: "top", key: "g2", after: true, before: "g3" });
        const drag = globalStore.get(panelViewDragAtom);
        expect(panelSideClass(drag, "top", "g2")).toBe("mt-sb-dropa");
        expect(panelSideClass(drag, "top", "g1")).toBeNull();
        expect(panelSideClass(drag, "tiles", "g2")).toBeNull();
        dragOver({ zone: "tiles", key: "tc", after: false, stacked: true, before: "tc" });
        expect(panelSideClass(globalStore.get(panelViewDragAtom), "tiles", "tc")).toBe("mt-sb-dropb mt-sb-dropy");
        expect(panelSideClass(null, "tiles", "tc")).toBeNull();
    });
});

describe("the other projects' zones", () => {
    const projects = [
        { id: "p1", type: "Desktop", dir: "/a", branch: "" },
        { id: "p2", type: "Site", dir: "/b", branch: "" },
        { id: "p3", type: "Docs", dir: "/c", branch: "" },
    ];
    const render = (list = projects) => inStore(<OtherProjectZones projects={list} current="p1" />);

    it("show only while a panel is dragged", () => {
        expect(render()).toBe("");
    });

    it("show one zone for each project but the current one, each saying where the view goes", () => {
        dragOver(null);
        const html = render();
        expect(html).toContain('data-sb-project="p2"');
        expect(html).toContain('data-sb-project="p3"');
        expect(html).not.toContain('data-sb-project="p1"');
        expect(html).toContain('data-cap="New view in the project Site"');
        expect(html).toContain('data-cap="New view in the project Docs"');
        expect(html).toContain("is-target");
    });

    it("light the one under the pointer the more", () => {
        dragOver({ zone: "project", projectId: "p3" });
        const html = render();
        const classesOf = (id: string) => new RegExp(`<div class="([^"]*)"[^>]*data-sb-project="${id}"`).exec(html)[1];
        expect(classesOf("p3")).toContain("is-over");
        expect(classesOf("p2")).not.toContain("is-over");
        expect(classesOf("p2")).toContain("is-target");
    });

    it("show nothing for a workspace with one project", () => {
        dragOver(null);
        expect(render(projects.slice(0, 1))).toBe("");
    });
});

describe("a view that was just made", () => {
    it("flows in once, then is drawn as the others", () => {
        function Probe({ id }: { id: string }) {
            return <span className={useFreshClass(id)} />;
        }
        globalStore.set(freshViewsAtom, ["tab-new"]);
        expect(inStore(<Probe id="tab-new" />)).toContain("mt-flow-in");
        expect(inStore(<Probe id="tab-old" />)).not.toContain("mt-flow-in");
        globalStore.set(freshViewsAtom, []);
        expect(inStore(<Probe id="tab-new" />)).not.toContain("mt-flow-in");
        expect(inStore(<Probe id="" />)).not.toContain("mt-flow-in");
    });
});

describe("the words", () => {
    it("are in both languages with the same placeholders", () => {
        const keys = Object.keys(en.sidebar.panelView);
        expect(Object.keys(fr.sidebar.panelView).sort()).toEqual(keys.sort());
        for (const key of keys) {
            const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
            expect(placeholders((fr.sidebar.panelView as any)[key])).toEqual(
                placeholders((en.sidebar.panelView as any)[key])
            );
        }
    });

    it("ask the agent's question as the developer decided", () => {
        expect(fr.sidebar.panelView.agentAsk).toBe("Déplacer l'agent dans la nouvelle vue ?");
        expect(fr.sidebar.panelView.menu).toBe("Créer une vue avec ce panneau");
        expect(fr.sidebar.panelView.open).toBe("Ouvrir");
    });
});
