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
    DialogFrame: ({ role, title, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role}>
            {children}
            {buttons}
        </div>
    ),
}));

import { ManageContextsDialog } from "./manage-contexts";

function dialog() {
    return renderToStaticMarkup(<ManageContextsDialog entries={[]} onClose={() => {}} />);
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

    it("keeps the name, the emblem, the workspaces, Delete, Close and Save", () => {
        h.contexts = [...h.contexts, { id: "other", name: "Other" }];
        const html = dialog();
        expect(html).toContain('data-testid="context-name"');
        expect(html).toContain('data-stub="emblem-picker"');
        expect(html).toContain("No saved workspace yet.");
        expect(html).toContain('data-testid="context-delete"');
        expect(html).toContain('data-testid="context-close"');
        expect(html).toContain('data-testid="context-save"');
    });

    it("says a context has no folder, and offers Choose… but nothing to remove", () => {
        const html = dialog();
        expect(html).toMatch(/data-testid="context-folder"[^>]*>[\s\S]*No folder/);
        expect(html).toMatch(/data-testid="context-folder-choose"[^>]*>Choose…</);
        expect(html).toMatch(/class="[^"]*\binvisible\b[^"]*"[^>]*data-testid="context-folder-remove"[^>]*disabled/);
        expect(html).toContain("Its workspaces stay in this folder. With no folder, nothing is limited.");
        expect(html).toMatch(/Folder\s*<span class="text-muted">· optional<\/span>/);
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

    it("lays the folder in a column that the ribbon's shape can join, never a fixed half", () => {
        const html = dialog();
        expect(html).toContain("repeat(auto-fit,minmax(14rem,1fr))");
        expect(html).toContain('data-testid="context-folder-column"');
    });
});
