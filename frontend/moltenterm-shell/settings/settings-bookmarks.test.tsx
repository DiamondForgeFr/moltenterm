// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { Provider, createStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { current } = vi.hoisted(() => ({ current: { client: null as any, ws: null as any, contexts: [] as any[] } }));

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
vi.mock("../contexts/context-store", () => ({
    useContexts: () => current.contexts,
    getContexts: () => current.contexts,
}));
vi.mock("../workspace-sources", () => ({ subscribeWorkspaceSources: () => () => {} }));
vi.mock("../dialog-frame", () => ({
    DialogFrame: ({ role, title, subtitle, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role}>
            <div data-subtitle="">{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import { BookmarkDialog, type BookmarkDialogRequest } from "../browser/bookmark-dialog";
import { BookmarksMetaKey, LevelProject, projectPlaceId } from "../browser/bookmarks";
import { BookmarksCard } from "./settings-bookmarks";

const P1 = projectPlaceId("w1", "p1");

function world(extra: { projects?: boolean; records?: any[]; folders?: any } = {}) {
    const projects = extra.projects !== false;
    current.contexts = [{ id: "sefers", name: "Client: SEFERS" }];
    current.client = {
        oid: "c1",
        version: 1,
        meta: {
            [BookmarksMetaKey]: {
                records: extra.records ?? [
                    {
                        id: "b1",
                        url: "https://vite.dev/config/",
                        title: "Vite config",
                        description: "The build options the renderer relies on.",
                        places: [
                            { level: "project", id: P1, folder: "f1" },
                            { level: "app", id: "", folder: "" },
                        ],
                    },
                    {
                        id: "b2",
                        url: "https://staging.example.com/",
                        title: "Staging",
                        description: "",
                        places: [{ level: "project", id: P1, folder: "" }],
                    },
                    {
                        id: "b3",
                        url: "https://ctx.example.com/",
                        title: "Context page",
                        description: "",
                        places: [{ level: "context", id: "sefers", folder: "" }],
                    },
                ],
                folders: extra.folders ?? { [`project:${P1}`]: [{ id: "f1", name: "Docs" }] },
            },
        },
    };
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
                          { id: "p1", type: "Desktop", dir: "/work/app" },
                          { id: "p2", type: "Website", dir: "/work/site" },
                      ],
                      "molten:currentproject": "p1",
                      "molten:project": "/work/app",
                      "molten:projecttype": "Desktop",
                  }
                : {}),
        },
    };
}

function render(node: React.ReactElement) {
    return renderToStaticMarkup(<Provider store={createStore()}>{node}</Provider>);
}

describe("Settings › Browser › Bookmarks (#2531)", () => {
    it("lists the places visible from the workspace: the app, its context, the workspace and each project", () => {
        world();
        const html = render(<BookmarksCard />);
        expect(html).toContain("Bookmarks");
        for (const place of ["The whole app", "Context · Client: SEFERS", "Workspace · Échanges", "Project · Desktop", "Project · Website"]) {
            expect(html, place).toContain(place);
        }
        expect(html.indexOf("The whole app")).toBeLessThan(html.indexOf("Context · Client: SEFERS"));
        expect(html.indexOf("Context · Client: SEFERS")).toBeLessThan(html.indexOf("Workspace · Échanges"));
        expect(html.indexOf("Workspace · Échanges")).toBeLessThan(html.indexOf("Project · Desktop"));
        expect(html).toContain("shown now");
    });

    it("lists a place's bookmarks outside folders, then its folders", () => {
        world();
        const html = render(<BookmarksCard />);
        const desktop = html.slice(html.indexOf('data-testid="bookmarks-place-project:' + P1));
        expect(desktop.indexOf("Staging")).toBeGreaterThan(-1);
        expect(desktop.indexOf("Staging")).toBeLessThan(desktop.indexOf("Docs"));
        expect(desktop.indexOf("Docs")).toBeLessThan(desktop.indexOf("Vite config"));
        expect(html).toContain("https://vite.dev/config/");
        expect(html).toContain("The build options the renderer relies on.");
        expect(html).toContain("No bookmark at this place yet.");
    });

    it("lists a bookmark placed at several places at each of them, as one bookmark with its number of places", () => {
        world();
        const html = render(<BookmarksCard />);
        expect(html.match(/Vite config<\/span>/g)).toHaveLength(2);
        expect(html).toContain("Placed at 2 places");
        expect(html).toContain('data-shared="true"');
        expect(html).toContain('data-testid="bookmark-delete-everywhere-b1"');
        expect(html).not.toContain('data-testid="bookmark-delete-everywhere-b2"');
    });

    it("offers edit, move, place also, remove and a folder's rename and delete, removing in two steps", () => {
        world();
        const html = render(<BookmarksCard />);
        expect(html).toContain('aria-label="Edit Vite config"');
        expect(html).toContain('aria-label="Move Vite config to a folder"');
        expect(html).toContain('aria-label="Also place Vite config at another place"');
        expect(html).toContain('aria-label="Remove Vite config from this place"');
        expect(html).toContain("Remove here");
        expect(html).toContain("Remove everywhere");
        expect(html).not.toContain("Click again");
        expect(html).toContain('aria-label="Rename the folder Docs"');
        expect(html).toContain("Delete folder");
        expect(html).toContain("Its bookmarks stay at this place.");
        expect(html).toContain(`data-testid="bookmark-add-project:${P1}"`);
        expect(html).toContain('data-testid="bookmark-add-app"');
        expect(html).not.toContain("Copy to project");
    });

    it("offers no move without a folder at the place, and no place-also for a bookmark at every place it can be", () => {
        world({
            projects: false,
            folders: {},
            records: [
                {
                    id: "b1",
                    url: "https://staging.example.com/",
                    title: "Staging",
                    description: "",
                    places: [{ level: "workspace", id: "w1", folder: "" }],
                },
            ],
        });
        const html = render(<BookmarksCard />);
        expect(html).not.toContain("Move Staging to a folder");
        expect(html).toContain("Also place Staging at another place");
        expect(html).not.toContain("shown now");
    });

    it("keeps working in a workspace with no project, listing the app, the context and the workspace", () => {
        world({
            projects: false,
            records: [
                {
                    id: "b3",
                    url: "https://ctx.example.com/",
                    title: "Context page",
                    description: "",
                    places: [{ level: "context", id: "sefers", folder: "" }],
                },
            ],
        });
        const html = render(<BookmarksCard />);
        expect(html).toContain("This workspace has no project yet: link one to keep bookmarks for it alone.");
        expect(html).toContain("Workspace · Échanges");
        expect(html).not.toContain("Project ·");
        expect(html).toContain("Context page");
    });
});

describe("the bookmark dialog of Settings", () => {
    const request: BookmarkDialogRequest = {
        ref: { level: LevelProject, id: P1 },
        placeName: "Project · Desktop",
        mode: "new",
        initial: { url: "https://example.com/page", title: "A page", description: "", folder: "" },
    };

    it("asks for the address, title, note and folder of a bookmark added at a place", () => {
        world();
        const html = render(<BookmarkDialog request={request} onClose={() => {}} />);
        expect(html).toContain("Add a bookmark");
        expect(html).toContain("At Project · Desktop");
        expect(html).toContain('value="https://example.com/page"');
        expect(html).toContain('value="A page"');
        expect(html).toContain("Note for agents");
        expect(html).toContain("What this page is for. The agents that see this bookmark read it.");
        expect(html).toContain("No folder");
        expect(html).toContain(">Docs<");
        expect(html).toContain("New folder…");
    });

    it("offers no other project to add the page to: a bookmark is placed from its popover and its places", () => {
        world();
        const html = render(<BookmarkDialog request={request} onClose={() => {}} />);
        expect(html).not.toContain("Also add to another project");
        expect(html).not.toContain("bookmark-also-");
    });

    it("edits the one bookmark, saying so, with no folder to choose", () => {
        world();
        const html = render(
            <BookmarkDialog
                request={{ ...request, mode: "edit", editingId: "b1", initial: { ...request.initial, title: "Vite config" } }}
                onClose={() => {}}
            />
        );
        expect(html).toContain("Edit bookmark");
        expect(html).toContain("The same bookmark at every place it is at");
        expect(html).not.toContain('data-testid="bookmark-folder"');
        expect(html).toContain("molten-btn");
        expect(html).toContain(">Save<");
    });

    it("says at once why a bookmark cannot be kept, only when saving fails", () => {
        world();
        const html = render(<BookmarkDialog request={request} onClose={() => {}} />);
        expect(html).not.toContain('data-testid="bookmark-problem"');
    });
});
