// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The folders' row and grid (FR-SHELL-080, #2484, DS-SHELL-125): what a folder's row says, what the open grid holds and
// how the keys move through it, the Views list with folders in it, and the style's own rules (the selected liseré, the
// tokens, reduced motion).

import { atoms, initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { atom, Provider } from "jotai";
import fs from "node:fs";
import path from "node:path";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import { pinTabWorkspace } from "../tab-workspace";
import { ViewFolder, ViewFoldersMetaKey } from "./view-folders-model";
import { FolderGrid, FolderRow, gridMove } from "./view-folders-ui";
import type { ListDrag, ListDragState } from "./view-list-drag";
import { TemporaryViews } from "./workspace-sidebar";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

const WorkspaceId = "ws-ui";

function update(obj: WaveObj) {
    WOS.updateWaveObject({ updatetype: "update", otype: obj.otype, oid: obj.oid, obj });
}

// A view of the workspace: its tab, with a first panel of the given kind when it has one.
function view(id: string, panel: Record<string, any> = null, name = id) {
    const blockids = panel == null ? [] : [`b-${id}`];
    if (panel != null) {
        update({ otype: "block", oid: `b-${id}`, version: 1, meta: panel } as unknown as Block);
    }
    update({ otype: "tab", oid: id, version: 1, name, blockids, meta: {} } as unknown as Tab);
}

let version = 1;

function workspace(tabids: string[], folders: ViewFolder[]) {
    version++;
    update({
        otype: "workspace",
        oid: WorkspaceId,
        version,
        tabids,
        meta: { [ViewFoldersMetaKey]: folders },
    } as unknown as Workspace);
}

const env = {
    getSettingsKeyAtom: () => atom(null),
    atoms,
    wos: WOS,
    showContextMenu: () => {},
};

const drag: ListDrag = { onMouseDown: () => {}, takeClick: () => false };

function render(node: React.ReactNode): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={env as any}>{node}</WaveEnvContext.Provider>
        </Provider>
    );
}

beforeAll(() => {
    initGlobalAtoms({ tabId: "t-a", windowId: "win-ui", clientId: "c", platform: "darwin" } as any);
    update({ otype: "window", oid: "win-ui", version: 1, workspaceid: WorkspaceId } as WaveWindow);
    for (const id of ["t-a", "t-b", "t-c", "t-d"]) {
        view(id, { view: "term" });
    }
    workspace(["t-a", "t-b", "t-c", "t-d"], []);
    pinTabWorkspace(WorkspaceId);
});

const folder: ViewFolder = { id: "f1", name: "", tabids: ["t-a", "t-b", "t-c"] };

describe("a folder's row", () => {
    const row = (over: Partial<Parameters<typeof FolderRow>[0]> = {}) =>
        render(
            <FolderRow folder={folder} members={folder.tabids} activeTabId={null} state={null} drag={drag} {...over} />
        );

    it("is a button that opens a dialog, named by its folder and its count", () => {
        const html = row();
        expect(html).toContain('data-testid="sidebar-folder-row"');
        expect(html).toContain('role="button"');
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('data-item-key="folder:f1"');
        expect(html).toContain('data-folder-id="f1"');
        expect(html).toMatch(/aria-label="Folder “Terminals”, 3 views"/);
    });

    it("shows its name, its count and up to four miniatures", () => {
        const html = row();
        expect(html).toMatch(/class="name[^"]*"[^>]*>Terminals<\/span>/);
        expect(html).toMatch(/data-testid="sidebar-folder-count">3</);
        expect(html.match(/class="mt-fo-mini"/g)).toHaveLength(3);
        const five = ["t-a", "t-b", "t-c", "t-d", "t-e"];
        expect(row({ folder: { ...folder, tabids: five }, members: five }).match(/class="mt-fo-mini"/g)).toHaveLength(
            4
        );
    });

    it("keeps the name the developer typed", () => {
        expect(row({ folder: { ...folder, name: "Mine" } })).toMatch(/aria-label="Folder “Mine”, 3 views"/);
    });

    it("is the selected one while the view on screen is inside it, with the shared liseré", () => {
        const html = row({ activeTabId: "t-b" });
        expect(html).toContain("mt-selected");
        expect(html).toContain('aria-current="true"');
        expect(row({ activeTabId: "t-z" })).not.toContain("mt-selected");
    });

    it("shows no dot of news when nothing is new", () => {
        expect(row()).not.toContain("sidebar-folder-news");
    });

    it("is ringed with its caption while a held drag is over it, and dims while it is dragged", () => {
        const over: ListDragState = {
            key: "tab:t-d",
            before: null,
            out: false,
            target: "folder:f1",
            away: false,
            inFrame: false,
        };
        const html = row({ state: over });
        expect(html).toContain('data-fo-target="true"');
        expect(html).toContain('data-fo-cap="Add to “Terminals”"');
        const dragged: ListDragState = { ...over, key: "folder:f1", target: null };
        expect(row({ state: dragged })).toContain("mt-sb-dragged");
        expect(row({ state: dragged })).not.toContain("data-fo-target");
    });

    it("reads in French", () => {
        expect(en.sidebar.folders.rowLabel.other).toBe("Folder “{name}”, {count} views");
        expect(fr.sidebar.folders.rowLabel.other).toBe("Dossier « {name} », {count} vues");
    });
});

describe("the open grid", () => {
    const host = {} as HTMLElement;
    const grid = (over: Partial<Parameters<typeof FolderGrid>[0]> = {}) =>
        render(
            <FolderGrid
                host={host}
                folder={folder}
                members={folder.tabids}
                activeTabId="t-b"
                state={null}
                drag={drag}
                {...over}
            />
        );

    it("is a dialog named by its folder, over a dimmed overlay", () => {
        const html = grid();
        expect(html).toContain('data-testid="sidebar-folder-overlay"');
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-label="Folder “Terminals”"');
        expect(html).toContain('aria-label="Views of the folder “Terminals”"');
    });

    it("holds an editable name and every view as a cell", () => {
        const html = grid();
        expect(html).toMatch(/<input[^>]*aria-label="Folder name"[^>]*value="Terminals"/);
        expect(html.match(/data-testid="sidebar-folder-cell"/g)).toHaveLength(3);
        expect(html).toContain("Drag a view out of the frame to take it out");
    });

    it("marks the view on screen, and gives one cell the tab stop", () => {
        const html = grid();
        expect(html.match(/aria-current="page"/g)).toHaveLength(1);
        const cells = html.match(/<div[^>]*data-testid="sidebar-folder-cell"[^>]*>/g);
        expect(cells).toHaveLength(3);
        expect(cells.filter((c) => c.includes('tabindex="0"'))).toHaveLength(1);
        expect(cells.filter((c) => c.includes('tabindex="-1"'))).toHaveLength(2);
    });

    it("lets go of the screen while a view is dragged out of its frame", () => {
        const away: ListDragState = {
            key: "tab:t-a",
            before: null,
            out: false,
            target: null,
            away: true,
            inFrame: false,
        };
        expect(grid({ state: away })).toContain('data-away="true"');
        expect(grid()).not.toContain("data-away");
    });
});

describe("the keys in the grid", () => {
    it("moves one cell right and left, stopping at the ends", () => {
        expect(gridMove("ArrowRight", 0, 5, 3)).toBe(1);
        expect(gridMove("ArrowRight", 4, 5, 3)).toBe(4);
        expect(gridMove("ArrowLeft", 2, 5, 3)).toBe(1);
        expect(gridMove("ArrowLeft", 0, 5, 3)).toBe(0);
    });

    it("moves a row up and down, staying when there is no cell there", () => {
        expect(gridMove("ArrowDown", 0, 5, 3)).toBe(3);
        expect(gridMove("ArrowDown", 2, 5, 3)).toBe(2);
        expect(gridMove("ArrowUp", 4, 5, 3)).toBe(1);
        expect(gridMove("ArrowUp", 1, 5, 3)).toBe(1);
    });

    it("goes to the first and the last cell with Home and End, and ignores other keys", () => {
        expect(gridMove("Home", 3, 5, 3)).toBe(0);
        expect(gridMove("End", 1, 5, 3)).toBe(4);
        expect(gridMove("a", 2, 5, 3)).toBe(2);
    });
});

describe("the Views list with folders", () => {
    const list = (ids: string[], active: string = null) =>
        render(<TemporaryViews ids={ids} activeTabId={active} asideRef={createRef<HTMLElement>()} />);

    it("shows a folder as one row in the place of its first view, and no row for its views", () => {
        workspace(["t-a", "t-b", "t-c", "t-d"], [{ id: "f1", name: "", tabids: ["t-b", "t-c"] }]);
        const html = list(["t-a", "t-b", "t-c", "t-d"]);
        expect(html.match(/data-testid="sidebar-folder-row"/g)).toHaveLength(1);
        expect(html.match(/data-testid="sidebar-view-row"/g)).toHaveLength(2);
        const order = [...html.matchAll(/data-item-key="([^"]+)"/g)].map((m) => m[1]);
        expect(order).toEqual(["tab:t-a", "folder:f1", "tab:t-d"]);
    });

    it("names the section a group of views and keeps Clear for the views outside folders", () => {
        workspace(["t-a", "t-b", "t-c", "t-d"], [{ id: "f1", name: "", tabids: ["t-b", "t-c"] }]);
        const html = list(["t-a", "t-b", "t-c", "t-d"]);
        expect(html).toContain('role="group"');
        expect(html).toContain('aria-label="Views"');
        expect(html).not.toMatch(/data-testid="sidebar-temporary-clear"[^>]*disabled/);
    });

    it("has nothing for Clear to close when every view is in a folder", () => {
        workspace(["t-a", "t-b"], [{ id: "f1", name: "", tabids: ["t-a", "t-b"] }]);
        const html = list(["t-a", "t-b"]);
        expect(html.match(/data-testid="sidebar-folder-row"/g)).toHaveLength(1);
        expect(html).toMatch(/data-testid="sidebar-temporary-clear"[^>]*disabled/);
        expect(html).toContain('data-testid="sidebar-temporary-separator" data-shown="true"');
    });

    it("lists the views as rows again once the folder is gone", () => {
        workspace(["t-a", "t-b"], []);
        const html = list(["t-a", "t-b"]);
        expect(html).not.toContain("sidebar-folder-row");
        expect(html.match(/data-testid="sidebar-view-row"/g)).toHaveLength(2);
    });

    it("has a live region for the changes it announces", () => {
        expect(list([])).toContain('data-testid="sidebar-folder-note"');
    });
});

describe("the folders' style", () => {
    const css = fs.readFileSync(path.join(__dirname, "view-folders.css"), "utf8");
    const rule = (selector: string) => {
        const at = css.indexOf(`${selector} {`);
        expect(at, selector).toBeGreaterThanOrEqual(0);
        return css.slice(at, css.indexOf("}", at));
    };

    it("rings the target with the action colour and its caption", () => {
        expect(rule('.mt-sb-tv [data-fo-target="true"]')).toContain("var(--mt-action)");
        expect(rule('.mt-sb-tv [data-fo-target="true"]::after')).toContain("content: attr(data-fo-cap)");
    });

    it("draws the dot of news in the action colour, round", () => {
        const dot = rule(".mt-fo-dot");
        expect(dot).toContain("var(--mt-action)");
        expect(dot).toContain("border-radius: 50%");
    });

    it("moves only through the duration tokens, and stops under reduced motion", () => {
        expect(css).not.toMatch(/\d+ms/);
        expect(css).toContain("@media (prefers-reduced-motion: reduce)");
        for (const selector of [".mt-fo-overlay", ".mt-fo-frame", ".mt-fo-cell"]) {
            expect(css, selector).toContain(`.prefers-reduced-motion ${selector}`);
        }
    });

    it("lets a view dragged out of the frame show the list beneath", () => {
        const away = rule('.mt-fo-overlay[data-away="true"]');
        expect(away).toContain("opacity: 0");
        expect(away).toContain("pointer-events: none");
    });

    it("takes the selected liseré from the shared class, never a bar of its own", () => {
        expect(css).not.toContain("inset 0 -2px");
        const source = fs.readFileSync(path.join(__dirname, "view-folders-ui.tsx"), "utf8");
        expect(source).toContain("mt-selected");
        expect(source).not.toMatch(/before:bg-accent|border-b-2/);
    });
});
