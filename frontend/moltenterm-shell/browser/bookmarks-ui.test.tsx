// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { Provider, createStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The window's state: the client object (where the bookmarks live), the workspace on screen and the contexts.
const { current } = vi.hoisted(() => ({
    current: { client: null as any, ws: null as any, contexts: [] as any[] },
}));

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    const clientAtom = atom(() => current.client);
    return { ClientModel: { getInstance: () => ({ clientAtom, clientId: "c1" }) } };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom(() => current.ws) }, globalStore: { get: () => current.client } };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (otype: string, oid: string) => `${otype}:${oid}` }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: async () => {} } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: { getInstance: () => ({ showContextMenu: () => {} }) },
}));
vi.mock("../contexts/context-store", () => ({
    useContexts: () => current.contexts,
    getContexts: () => current.contexts,
}));
vi.mock("../workspace-sources", () => ({ subscribeWorkspaceSources: () => () => {} }));
vi.mock("../mission/menu-popover", () => ({
    MenuPopover: ({ children, className, role, ariaLabel }: any) => (
        <div className={className} role={role} aria-label={ariaLabel} data-testid="menu-popover">
            {children}
        </div>
    ),
}));

import { BookmarkAddButton, BookmarksPanelButton } from "./bookmark-buttons";
import { BookmarkPopover, Finder } from "./bookmark-popover";
import { BookmarksPanel, Path } from "./bookmarks-panel";
import { catalogFromWorkspaces } from "./bookmark-world";
import {
    addBookmark,
    BookmarksMetaKey,
    createFolder,
    EmptyStore,
    LevelApp,
    LevelContext,
    LevelProject,
    LevelWorkspace,
    placeBookmark,
    projectPlaceId,
    readStore,
    storeValue,
    type BookmarkStore,
    type PlaceRef,
} from "./bookmarks";

const App: PlaceRef = { level: LevelApp, id: "" };
const Ctx: PlaceRef = { level: LevelContext, id: "sefers" };
const Ws: PlaceRef = { level: LevelWorkspace, id: "w1" };
const P1: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p1") };
const OtherP1: PlaceRef = { level: LevelProject, id: projectPlaceId("w9", "p1") };

function setWorld(store: BookmarkStore, projects = true) {
    current.contexts = [{ id: "sefers", name: "Client: SEFERS" }, { id: "pro", name: "Mes logiciels pro" }];
    current.client = { oid: "c1", version: 1, meta: { [BookmarksMetaKey]: JSON.parse(JSON.stringify(storeValue(store))) } };
    current.ws = {
        oid: "w1",
        name: "Échanges",
        icon: "bolt",
        color: "#2fa6a0",
        meta: {
            "molten:context": "sefers",
            ...(projects
                ? {
                      "molten:projects": [
                          { id: "p1", type: "site-web", dir: "/work/web" },
                          { id: "p2", type: "app-mobile", dir: "/work/mobile" },
                      ],
                      "molten:currentproject": "p1",
                      "molten:project": "/work/web",
                      "molten:projecttype": "site-web",
                  }
                : {}),
        },
    };
}

let counter = 0;
const makeId = (prefix: "b" | "f") => `${prefix}${++counter}`;

function build(...steps: ((s: BookmarkStore) => BookmarkStore)[]): BookmarkStore {
    counter = 0;
    return steps.reduce((store, step) => step(store), EmptyStore);
}

const addAt =
    (ref: PlaceRef, url = "https://recette.example/", title = "Recette", folder?: string) =>
    (store: BookmarkStore) => {
        const added = addBookmark(store, { url, title, description: "" }, ref, folder ? { newFolder: folder } : {}, makeId);
        return added.value.store;
    };
const placeAt = (id: string, ref: PlaceRef) => (store: BookmarkStore) => placeBookmark(store, id, ref, {}, makeId).value;

function render(node: React.ReactElement) {
    return renderToStaticMarkup(<Provider store={createStore()}>{node}</Provider>);
}

const host = { tabId: "tab1", openPage: () => {}, captureFavicon: () => {}, close: () => {} };
const page = { url: "https://recette.example/", title: "Recette" };

describe("the add button (mockup 1)", () => {
    const html = (url: string) =>
        render(<BookmarkAddButton tabId="tab1" pageUrl={url} onClick={() => {}} className="molten-fold-4" />);

    it("is filled for a page that is a bookmark at a place visible from here", () => {
        setWorld(build(addAt(Ws)));
        const out = html("https://recette.example/#top");
        expect(out).toContain('data-saved="true"');
        expect(out).toContain('data-state="here"');
        expect(out).toContain('fill="currentColor"');
        expect(out).toContain('aria-label="Edit this bookmark"');
        expect(out).toContain("molten-fold-4");
    });

    it("stays empty for a page that is a bookmark only elsewhere, and for one that is a bookmark nowhere", () => {
        setWorld(build(addAt(OtherP1)));
        const elsewhere = html("https://recette.example/");
        expect(elsewhere).toContain('data-saved="false"');
        expect(elsewhere).toContain('data-state="elsewhere"');
        expect(elsewhere).toContain('fill="none"');
        expect(elsewhere).toContain('aria-label="Bookmark this page"');
        const nowhere = html("https://other.example/");
        expect(nowhere).toContain('data-state="none"');
    });

    it("is unavailable on the start page", () => {
        setWorld(build(addAt(Ws)));
        const out = html("about:blank#moltenterm-start");
        expect(out).toContain("disabled");
        expect(out).toContain("This page cannot be bookmarked");
    });

    it("draws the book button pressed with only the header's active fill while the panel is open", () => {
        const open = render(<BookmarksPanelButton open onClick={() => {}} />);
        expect(open).toContain('aria-pressed="true"');
        expect(open).not.toContain("mt-selected");
        expect(render(<BookmarksPanelButton open={false} onClick={() => {}} />)).toContain('aria-pressed="false"');
    });
});

describe("the popover (mockup 2)", () => {
    const fresh = (id = "b1") => ({ kind: "bookmark" as const, id, fresh: true });
    const popover = (request: any) =>
        render(
            <BookmarkPopover anchor={null} tabId="tab1" request={request} setRequest={() => {}} onClose={() => {}} />
        );

    it("says the bookmark is added, with its name and its note for agents", () => {
        setWorld(build(addAt(P1)));
        const out = popover(fresh());
        expect(out).toContain("Bookmark added");
        expect(out).toContain('value="Recette"');
        expect(out).toContain("Note for agents");
        expect(out).toContain("Optional: what this page is for");
    });

    it("lists the four levels of here as checkboxes, checked where it is, with a sentence on where it is visible", () => {
        setWorld(build(addAt(P1)));
        const out = popover(fresh());
        for (const text of [
            "The whole app",
            "Context · Client: SEFERS",
            "Workspace · Échanges",
            "Project · site-web",
            "Everywhere in MoltenTerm",
            "In all its workspaces",
            "In every tab of this workspace",
            "Only with this project",
        ]) {
            expect(out, text).toContain(text);
        }
        expect(out.match(/type="checkbox"/g)).toHaveLength(4);
        expect(out.match(/type="checkbox"[^>]*checked/g)).toHaveLength(1);
        expect(out.match(/data-checked/g)).toHaveLength(1);
        expect(out).toContain("1 place");
        expect(out).toContain("Add to another place…");
    });

    it("gives each checked place its own folder picker, and shows the folder it is in", () => {
        counter = 0;
        let store = build(addAt(P1));
        const made = createFolder(store, Ws, "Environments", makeId).value;
        store = placeBookmark(made.store, "b1", Ws, { folder: made.folder.id }, makeId).value;
        setWorld(store);
        const out = popover(fresh());
        expect(out.match(/data-testid="bookmark-folder"/g)).toHaveLength(2);
        expect(out).toContain("Folder: Environments");
        expect(out).toContain("Folder: No folder");
        expect(out).toContain("2 places");
    });

    it("leaves the project row out in a workspace with no linked project", () => {
        setWorld(build(addAt(Ws)), false);
        const out = popover(fresh());
        expect(out).not.toContain("Project ·");
        expect(out.match(/type="checkbox"/g)).toHaveLength(3);
    });

    it("shows a place that is not one of the levels of here as a checked row with its path", () => {
        setWorld(build(addAt(P1), placeAt("b1", OtherP1)));
        const out = popover(fresh());
        expect(out.match(/type="checkbox"/g)).toHaveLength(5);
        expect(out.match(/data-checked/g)).toHaveLength(2);
    });

    it("offers Remove everywhere and Done, the latter as a molten button", () => {
        setWorld(build(addAt(P1)));
        const out = popover(fresh());
        expect(out).toContain('data-testid="bookmark-remove-everywhere"');
        expect(out).toContain("Remove everywhere");
        const done = out.slice(out.indexOf('data-testid="bookmark-done"') - 120, out.indexOf('data-testid="bookmark-done"') + 200);
        expect(done).toContain("molten-btn");
        expect(done).toContain("molten-btn-wave");
    });

    it("asks, for a page bookmarked only elsewhere, whether to place it here or to copy it (mockup 2 bis)", () => {
        setWorld(build(addAt(OtherP1)));
        const out = popover({ kind: "elsewhere", id: "b1" });
        expect(out).toContain("Already bookmarked");
        expect(out).toContain("Place it here too");
        expect(out).toContain("Place here");
        expect(out).toContain("Make another bookmark");
        expect(out).toContain("A separate copy, with its own name");
        expect(out).toContain('data-testid="bookmark-place-here"');
        expect(out).toContain('data-testid="bookmark-copy-here"');
        expect(out).not.toContain('type="checkbox"');
    });

    it("says why a page could not be bookmarked, and nothing else", () => {
        setWorld(build(addAt(Ws)));
        const out = popover({ kind: "problem", problem: "browser.bookmarks.problem.credentials" });
        expect(out).toContain("Remove the user name and password");
        expect(out).not.toContain('type="checkbox"');
    });

    it("draws nothing for a bookmark that is gone", () => {
        setWorld(EmptyStore);
        const out = popover(fresh("b9"));
        expect(out).not.toContain("Bookmark added");
        expect(out).not.toContain('type="checkbox"');
    });
});

describe("the place finder (mockup 2 ter)", () => {
    const finder = (typed: string, ...steps: ((s: BookmarkStore) => BookmarkStore)[]) => {
        setWorld(build(addAt(P1), ...steps));
        const catalog = catalogFromWorkspaces([], current.ws, current.contexts, (k: string) => k);
        const here = { contextId: "sefers", workspaceId: "w1", projectId: "p1" };
        const bookmark = readStore(current.client.meta).records[0];
        return render(
            <Finder bookmark={bookmark} catalog={catalog} here={here} initialTyped={typed} onBack={() => {}} onProblem={() => {}} />
        );
    };

    it("replaces the places block with a search field, a list and the keys it answers to", () => {
        const out = finder("mob");
        expect(out).toContain("Another place");
        expect(out).toContain('data-testid="bookmark-finder-input"');
        expect(out).toContain('role="combobox"');
        expect(out).toContain('role="listbox"');
        expect(out).toContain("↑ ↓ to choose, ↵ to add");
        expect(out).toContain('data-testid="bookmark-finder-back"');
        expect(out).toContain("Back");
    });

    it("underlines the letters found, shows the type and the path, and selects the first result with its key", () => {
        const out = finder("mob");
        expect(out).toContain('<u class="molten-bm-found">m</u>');
        expect(out).toContain("Project · Client: SEFERS › Échanges");
        expect(out).toContain('aria-selected="true"');
        expect(out).toContain("↵");
        expect(out).toContain("Results");
    });

    it("marks a place the bookmark is already at, without offering to add it", () => {
        const out = finder("mob", placeAt("b1", { level: LevelProject, id: projectPlaceId("w1", "p2") }));
        const item = out.slice(out.indexOf('data-there="true"'));
        expect(item).toContain("already there");
    });

    it("lists Near here with nothing typed, then the recent places", () => {
        const out = finder("");
        expect(out).toContain("Near here");
        expect(out).toContain("app-mobile");
        expect(out).not.toContain("Results");
    });

    it("says so when no place matches", () => {
        expect(finder("zzzz")).toContain("No place matches.");
    });
});

describe("the bookmarks panel (mockup 3)", () => {
    const panel = (start?: any) => render(<BookmarksPanel host={host} page={page} start={start} />);
    const world = () =>
        build(
            addAt(App, "https://docs.example/", "Docs"),
            addAt(Ctx, "https://billing.example/", "Facturation"),
            addAt(Ws, "https://linear.example/", "Linear"),
            addAt(P1, "https://recette.example/", "Recette"),
            placeAt("b4", Ws),
            addAt(P1, "https://git.example/", "Dépôt", "Environnements")
        );

    it("opens on the current place with its dot, no title, and the selected item of each column marked", () => {
        setWorld(world());
        const out = panel();
        expect(out).toContain('data-testid="bookmarks-panel"');
        expect(out).toContain('data-testid="bookmarks-here"');
        expect(out.match(/data-testid="bookmarks-here"/g)).toHaveLength(2);
        // The three columns shown are the context's, the workspace's and the project's: the context's selects the
        // workspace, the workspace's selects the project.
        expect(out.match(/mt-selected/g)).toHaveLength(2);
        expect(out).not.toMatch(/<h[1-6]/);
        expect(out).toContain('data-testid="bookmarks-path"');
    });

    it("shows at most three columns, the last levels, whatever the chain", () => {
        setWorld(world());
        const out = panel();
        const columns = out.match(/data-testid="bookmarks-column"/g) ?? [];
        expect(columns.length).toBeLessThanOrEqual(3);
        expect(out).toContain('data-column="workspace:w1"');
        expect(out).toContain(`data-column="project:${P1.id}"`);
    });

    it("draws the top line with Back, the path, the bordered search and Close, in this order", () => {
        setWorld(world());
        const out = panel();
        const order = ["bookmarks-back", "bookmarks-path", "bookmarks-search-button", "bookmarks-close"].map((id) =>
            out.indexOf(`data-testid="${id}"`)
        );
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("lets the search replace the path, with a field the width of the line and the results with their path", () => {
        setWorld(world());
        const out = panel({ searching: true, typed: "rec" });
        expect(out).toContain('data-testid="bookmarks-search"');
        expect(out).not.toContain('data-testid="bookmarks-path"');
        expect(out).toContain('data-testid="bookmarks-results"');
        expect(out).not.toContain('data-testid="bookmarks-columns"');
        expect(out).toContain("<u");
        expect(out).toContain("Échanges");
        expect(out).toContain('aria-pressed="true"');
    });

    it("gives the path back, and the columns, when the search is not on", () => {
        setWorld(world());
        const out = panel();
        expect(out).not.toContain('data-testid="bookmarks-search"');
        expect(out).toContain('data-testid="bookmarks-columns"');
    });

    it("has New folder (quiet) and Add the page (molten button) at the bottom, acting on the deepest level shown", () => {
        setWorld(world());
        const out = panel();
        const add = out.slice(out.indexOf('data-testid="bookmarks-add-page"') - 200);
        expect(out).toContain('data-testid="bookmarks-new-folder-button"');
        expect(out).toContain("New folder");
        expect(add).toContain("Add the page");
        expect(out.slice(out.indexOf('data-testid="bookmarks-add-page"') - 200, out.indexOf('data-testid="bookmarks-add-page"'))).toContain(
            "molten-btn"
        );
    });

    it("disables Add the page on a page that cannot be bookmarked", () => {
        setWorld(world());
        const out = render(<BookmarksPanel host={host} page={{ url: "about:blank#moltenterm-start", title: "" }} />);
        const tag = out.slice(out.lastIndexOf("<button", out.indexOf('data-testid="bookmarks-add-page"')), out.indexOf('data-testid="bookmarks-add-page"'));
        expect(tag).toContain("disabled");
    });

    it("marks a bookmark placed at several places with the shortcut mark and its count", () => {
        setWorld(world());
        const out = panel();
        expect(out).toContain('data-shared="true"');
        expect(out).toContain("molten-bm-alias");
    });

    it("makes bookmarks draggable and levels and folders drop targets, but offers no way to create a level", () => {
        setWorld(world());
        const out = panel({ selection: { path: [Ctx], folder: "" } });
        expect(out).toContain('draggable="true"');
        expect(out).not.toMatch(/New (context|workspace|project)/i);
        expect(out).toContain("Contexts");
        expect(out).toContain("Workspaces");
        expect(out).toContain("Client: SEFERS");
        expect(out).toContain("Mes logiciels pro");
    });

    it("shows fewer columns when the chain is shorter, and the app's own column first", () => {
        setWorld(world());
        const out = panel({ selection: { path: [Ctx], folder: "" } });
        expect(out.match(/data-testid="bookmarks-column"/g)).toHaveLength(2);
        expect(out.indexOf('data-column="app"')).toBeLessThan(out.indexOf('data-column="context:sefers"'));
    });

    it("shrinks the path in the middle when it does not fit, with the hidden levels behind the ellipsis", () => {
        setWorld(world());
        const catalog = catalogFromWorkspaces([], current.ws, current.contexts, (k: string) => (k === "browser.bookmarks.place.app" ? "The whole app" : k));
        const selection = { path: [Ctx, Ws, P1], folder: "" };
        const wide = render(<Path catalog={catalog} selection={selection} store={EmptyStore} room={200} onGo={() => {}} />);
        expect(wide).not.toContain('data-testid="bookmarks-crumb-more"');
        expect(wide.match(/data-testid="bookmarks-crumb"/g)).toHaveLength(4);
        const tight = render(<Path catalog={catalog} selection={selection} store={EmptyStore} room={25} onGo={() => {}} />);
        expect(tight).toContain('data-testid="bookmarks-crumb-more"');
        expect(tight.match(/data-testid="bookmarks-crumb"/g)).toHaveLength(2);
        expect(tight).toContain("The whole app");
        expect(tight).toContain("site-web");
        expect(tight).not.toContain("Échanges");
        expect(tight).toContain('aria-current="location"');
    });

    it("has a grip on its left edge to resize it", () => {
        setWorld(world());
        const out = panel();
        expect(out).toContain('data-testid="bookmarks-grip"');
        expect(out).toContain('aria-orientation="vertical"');
        expect(out).toContain('aria-valuemin="360"');
    });

    it("lists the folders of a place before its bookmarks, with their count", () => {
        setWorld(world());
        const out = panel();
        const column = out.slice(out.indexOf(`data-column="project:${P1.id}"`));
        expect(column).toContain("Environnements");
        expect(column).toContain("Recette");
        expect(column.indexOf("Environnements")).toBeLessThan(column.indexOf("Recette"));
    });
});
