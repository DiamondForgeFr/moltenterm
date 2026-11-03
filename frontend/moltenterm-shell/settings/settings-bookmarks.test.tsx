// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { Provider, createStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { current } = vi.hoisted(() => ({ current: { ws: null as any } }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom(() => current.ws) }, globalStore: { get: () => current.ws } };
});
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: () => ({}),
}));
vi.mock("../sidebar/workspace-projects-store", () => ({ writeMeta: async () => {} }));
vi.mock("../dialog-frame", () => ({
    DialogFrame: ({ role, title, subtitle, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role}>
            <div data-subtitle="">{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import { BookmarkDialog } from "../browser/bookmark-dialog";
import { BookmarksMetaKey } from "../browser/bookmarks";
import { BookmarksCard } from "./settings-bookmarks";

function workspace(extra: Record<string, any> = {}) {
    return {
        oid: "w1",
        meta: {
            "molten:projects": [
                { id: "p1", type: "Desktop", dir: "/work/app" },
                { id: "p2", type: "Website", dir: "/work/site" },
            ],
            "molten:currentproject": "p1",
            "molten:project": "/work/app",
            "molten:projecttype": "Desktop",
            [BookmarksMetaKey]: {
                p1: {
                    folders: [{ id: "f1", name: "Docs" }],
                    items: [
                        {
                            id: "b1",
                            url: "https://vite.dev/config/",
                            title: "Vite config",
                            description: "The build options the renderer relies on.",
                            folder: "f1",
                        },
                        {
                            id: "b2",
                            url: "https://staging.example.com/",
                            title: "Staging",
                            description: "",
                            folder: "",
                        },
                    ],
                },
            },
            ...extra,
        },
    };
}

function render(node: React.ReactElement) {
    return renderToStaticMarkup(<Provider store={createStore()}>{node}</Provider>);
}

describe("Settings › Browser › Bookmarks", () => {
    it("lists every project of the workspace, its bookmarks outside folders, then its folders", () => {
        current.ws = workspace();
        const html = render(<BookmarksCard />);
        expect(html).toContain("Bookmarks");
        expect(html).toContain("Desktop");
        expect(html).toContain("Website");
        expect(html).toContain("shown now");
        expect(html.indexOf("Staging")).toBeGreaterThan(-1);
        expect(html.indexOf("Staging")).toBeLessThan(html.indexOf("Docs"));
        expect(html.indexOf("Docs")).toBeLessThan(html.indexOf("Vite config"));
        expect(html).toContain("https://vite.dev/config/");
        expect(html).toContain("The build options the renderer relies on.");
        expect(html).toContain("No bookmark in this project yet.");
    });

    it("offers edit, move, copy and a two-step delete on each bookmark, and rename and delete on each folder", () => {
        current.ws = workspace();
        const html = render(<BookmarksCard />);
        expect(html).toContain('aria-label="Edit Vite config"');
        expect(html).toContain('aria-label="Move Vite config to a folder"');
        expect(html).toContain('aria-label="Copy Vite config to another project"');
        expect(html).toContain('aria-label="Delete Vite config"');
        expect(html).toContain(">Delete<");
        expect(html).not.toContain("Click again");
        expect(html).toContain('aria-label="Rename the folder Docs"');
        expect(html).toContain("Delete folder");
        expect(html).toContain("Its bookmarks stay in the project.");
        expect(html).toContain('data-testid="bookmark-add-p1"');
        expect(html).toContain('data-testid="bookmark-add-p2"');
    });

    it("offers no copy to another project when the workspace has one project, and no move without a folder", () => {
        current.ws = workspace({
            "molten:projects": [{ id: "p1", type: "Desktop", dir: "/work/app" }],
            [BookmarksMetaKey]: {
                p1: {
                    folders: [],
                    items: [
                        {
                            id: "b2",
                            url: "https://staging.example.com/",
                            title: "Staging",
                            description: "",
                            folder: "",
                        },
                    ],
                },
            },
        });
        const html = render(<BookmarksCard />);
        expect(html).not.toContain("Copy Staging to another project");
        expect(html).not.toContain("Move Staging to a folder");
        expect(html).not.toContain("shown now");
        expect(html).toContain("Staging");
    });

    it("says that bookmarks belong to a project in a workspace without one", () => {
        current.ws = { oid: "w2", meta: {} };
        const html = render(<BookmarksCard />);
        expect(html).toContain("This workspace has no project yet");
    });
});

describe("the bookmark dialog", () => {
    const request = {
        projectId: "p1",
        projectName: "Desktop",
        mode: "page" as const,
        initial: { url: "https://example.com/page", title: "A page", description: "", folder: "" },
    };

    it("asks for the address, title, description and folder of a page, and names the project", () => {
        current.ws = workspace();
        const html = render(<BookmarkDialog request={request} onClose={() => {}} />);
        expect(html).toContain("Bookmark this page");
        expect(html).toContain("In the project Desktop");
        expect(html).toContain('value="https://example.com/page"');
        expect(html).toContain('value="A page"');
        expect(html).toContain("What this page is for. The agents of this project read it.");
        expect(html).toContain("In the project, outside any folder");
        expect(html).toContain(">Docs<");
        expect(html).toContain("New folder…");
        expect(html).toContain("Add bookmark");
    });

    it("offers the other projects to add the page to, none ticked, and marks one that has it already", () => {
        current.ws = workspace({
            [BookmarksMetaKey]: {
                p2: {
                    folders: [],
                    items: [{ id: "b9", url: "https://example.com/page", title: "x", description: "", folder: "" }],
                },
            },
        });
        const html = render(<BookmarkDialog request={request} onClose={() => {}} />);
        expect(html).toContain("Also add to another project");
        expect(html).toContain('data-testid="bookmark-also-p2"');
        expect(html).toContain("already there");
        expect(html).not.toContain("checked");
        expect(html).not.toContain('data-testid="bookmark-also-p1"');
        const single = (current.ws = workspace({
            "molten:projects": [{ id: "p1", type: "Desktop", dir: "/work/app" }],
        }));
        expect(single).toBeTruthy();
        expect(render(<BookmarkDialog request={request} onClose={() => {}} />)).not.toContain(
            "Also add to another project"
        );
    });

    it("edits an existing bookmark without the other projects", () => {
        current.ws = workspace();
        const html = render(
            <BookmarkDialog
                request={{
                    projectId: "p1",
                    projectName: "Desktop",
                    mode: "edit",
                    editingId: "b1",
                    initial: {
                        url: "https://vite.dev/config/",
                        title: "Vite config",
                        description: "Note",
                        folder: "f1",
                    },
                }}
                onClose={() => {}}
            />
        );
        expect(html).toContain("Edit bookmark");
        expect(html).not.toContain("Also add to another project");
        expect(html).toContain('<option value="f1" selected="">Docs</option>');
        expect(html).toContain(">Note</textarea>");
        expect(html).toContain(">Save<");
    });
});
