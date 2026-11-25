// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    contexts: [] as { id: string; name?: string; description?: string; emblem?: string; folder?: string }[],
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom(null) } };
});
vi.mock("./context-store", () => ({
    useContexts: () => h.contexts,
    createContext: async () => "",
    deleteContext: async () => {},
    updateContext: async () => {},
    setContextFolder: async () => {},
}));
vi.mock("../workspace-project-store", () => ({ chooseMoltentermPath: async () => null }));
vi.mock("./emblem-picker", () => ({ EmblemPicker: () => <div data-stub="emblem-picker" /> }));
// The real frame portals into document.body; the dialog's content is what is checked here.
vi.mock("../dialog-frame", () => ({
    DialogFrame: ({ role, title, children, buttons, closeButton }: any) => (
        <div role="dialog" aria-label={title} data-role={role}>
            {closeButton ? (
                <button type="button" aria-label={closeButton.label} data-testid={closeButton.testId}>
                    x
                </button>
            ) : null}
            {children}
            {buttons}
        </div>
    ),
}));

import { ManageContextsDialog } from "./manage-contexts";

function dialog() {
    return renderToStaticMarkup(<ManageContextsDialog entries={[]} onClose={() => {}} />);
}

function blockNames(html: string): string[] {
    return [...html.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]);
}

beforeEach(() => {
    h.contexts = [{ id: "client", name: "Client: SEFERS", description: "Odoo\nand billing", emblem: "briefcase" }];
});

// #2518: the description is text on several lines, and a context may have a folder.
describe("Manage contexts", () => {
    it("takes the description in a multi-line field that keeps its lines", () => {
        const html = dialog();
        expect(html).toMatch(/<textarea[^>]*data-testid="context-description"/);
        expect(html).toMatch(/<textarea[^>]*rows="3"/);
        expect(html).not.toMatch(/<input[^>]*data-testid="context-description"/);
        expect(html).toContain("Odoo\nand billing");
    });

    it("keeps the name, the emblem, the workspaces, Delete, Cancel, the cross and Save", () => {
        h.contexts = [...h.contexts, { id: "other", name: "Other" }];
        const html = dialog();
        expect(html).toContain('data-testid="context-name"');
        expect(html).toContain('data-stub="emblem-picker"');
        expect(html).toContain("No saved workspace yet.");
        expect(html).toContain('data-testid="context-delete"');
        expect(html).toMatch(/data-testid="context-cancel"[^>]*>Cancel</);
        expect(html).toMatch(/aria-label="Close"[^>]*data-testid="context-close"/);
        expect(html).toContain('data-testid="context-save"');
    });

    it("says a context has no folder, and offers Choose… but nothing to remove", () => {
        const html = dialog();
        expect(html).toMatch(/data-testid="context-folder"[^>]*>[\s\S]*No folder/);
        expect(html).toMatch(/data-testid="context-folder-choose"[^>]*>Choose…</);
        expect(html).toMatch(/class="[^"]*\binvisible\b[^"]*"[^>]*data-testid="context-folder-remove"[^>]*disabled/);
        expect(html).toContain("Its workspaces stay in this folder. With no folder, nothing is limited.");
        expect(html).toMatch(/>Folder<\/h3>/);
        expect(html).toMatch(/>optional<\/span>/);
    });

    it("shows the folder it has, and a Remove that is there to be used", () => {
        h.contexts = [{ ...h.contexts[0], folder: "/clients/sefers" }];
        const html = dialog();
        expect(html).toMatch(/data-testid="context-folder"[^>]*>[\s\S]*\/clients\/sefers/);
        expect(html).toContain('title="/clients/sefers"');
        expect(html).not.toMatch(/class="[^"]*\binvisible\b[^"]*"[^>]*data-testid="context-folder-remove"/);
        expect(html).not.toMatch(/data-testid="context-folder-remove"[^>]*disabled/);
        expect(html).toMatch(/data-testid="context-folder-remove"[^>]*>Remove</);
    });

    it("draws the form as the suite's blocks in one grid that puts two side by side while there is room", () => {
        h.contexts = [...h.contexts, { id: "other", name: "Other" }];
        const html = dialog();
        const grid = html.indexOf("repeat(auto-fit,minmax(21rem,1fr))");
        expect(grid).toBeGreaterThan(0);
        expect(grid).toBeLessThan(html.indexOf('data-block="identity"'));
        // The pairs of a wide dialog: Identity and Emblem, Ribbon and Workspaces, Folder and the Danger zone.
        expect(blockNames(html)).toEqual(["identity", "emblem", "ribbon", "workspaces", "folder", "danger"]);
        expect(html.match(/class="df-block /g)).toHaveLength(6);
        expect(html.match(/class="df-icon-tile"/g)).toHaveLength(6);
        for (const name of ["Identity", "Emblem", "Ribbon", "Workspaces", "Folder", "Danger zone"]) {
            expect(html).toContain(`>${name}</h3>`);
        }
        expect(html).toContain('data-tone="danger"');
    });

    it("lets the Folder take the whole row when there is no Danger zone beside it", () => {
        const html = dialog();
        expect(blockNames(html)).toEqual(["identity", "emblem", "ribbon", "workspaces", "folder"]);
        expect(html).not.toContain('data-testid="context-delete"');
        expect(html).toMatch(/<section[^>]*data-block="folder"[^>]*class="[^"]*\bcol-span-full\b/);
        h.contexts = [...h.contexts, { id: "other", name: "Other" }];
        expect(dialog()).not.toContain("col-span-full");
    });

    it("tags each block with who or what it is for", () => {
        const html = dialog();
        expect(html).toContain("For this context");
        expect(html).toMatch(/data-testid="context-emblem-name">briefcase</);
        expect(html).toMatch(/data-testid="context-ribbon-preview"/);
        expect(html).toContain("The shape of the ribbon&#x27;s end, unique among the contexts of the same colour.");
    });

    it("keeps the ribbon's fifteen shapes, its preview and Draw another in the Ribbon block", () => {
        const html = dialog();
        const ribbon = html.slice(html.indexOf('data-block="ribbon"'), html.indexOf('data-block="workspaces"'));
        expect(ribbon.match(/role="radio"/g)).toHaveLength(15);
        expect(ribbon).toContain('data-testid="shape-draw-another"');
        expect(ribbon).toContain("mt-ribbon-shape");
    });

    it("counts the workspaces ticked, and says where one that is elsewhere is", () => {
        h.contexts = [...h.contexts, { id: "other", name: "Other" }];
        const entries = [
            { id: "w1", name: "SASU", color: "#c9d65a", saved: true, contextId: "client" },
            { id: "w2", name: "Échanges", color: "#2FA6A0", saved: true, contextId: "other" },
        ] as any[];
        const html = renderToStaticMarkup(<ManageContextsDialog entries={entries} onClose={() => {}} />);
        expect(html).toMatch(/data-testid="context-workspaces-count"[^>]*>1 of 2</);
        expect(html).toContain('data-workspace-id="w1"');
        expect(html).toContain("in Other");
        expect(html.match(/data-testid="context-workspace"/g)).toHaveLength(2);
    });
});
