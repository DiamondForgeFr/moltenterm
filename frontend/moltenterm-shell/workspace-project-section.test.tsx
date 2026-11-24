// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    contextFolder: "",
    context: { id: "client", name: "Client: SEFERS", emblem: "briefcase" } as {
        id: string;
        name?: string;
        emblem?: string;
    },
}));

vi.mock("./contexts/context-store", () => ({
    useContextFolder: () => h.contextFolder,
    useContextOf: () => h.context,
    checkWorkspaceFolder: async () => ({ outside: false }),
}));
vi.mock("./workspace-project-store", () => ({
    chooseMoltentermPath: async () => null,
    linkWorkspaceProject: async () => "",
    readProjectFacts: async () => null,
    setWorkspaceFolder: async () => {},
    unlinkWorkspaceProject: async () => {},
}));
// The real frame portals into document.body; the dialog's content is what is checked here.
vi.mock("./dialog-frame", () => ({
    DialogFrame: ({ role, title, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role}>
            {children}
            {buttons}
        </div>
    ),
}));

import { FolderOutsideDialog } from "./workspace-folder-outside";
import { ProjectMetaKey, WorkspaceFolderChosenMetaKey, WorkspaceFolderMetaKey } from "./workspace-project";
import { WorkspaceFolderLine, WorkspaceProjectBlock } from "./workspace-project-section";

function workspace(meta: Record<string, any>): Workspace {
    return { oid: "w1", name: "Echanges", color: "#E07A36", meta, tabids: [], activetabid: "" } as any as Workspace;
}

const chosen = (folder: string, more: Record<string, any> = {}) =>
    workspace({ [WorkspaceFolderMetaKey]: folder, [WorkspaceFolderChosenMetaKey]: true, ...more });

function line(ws: Workspace) {
    return renderToStaticMarkup(<WorkspaceFolderLine ws={ws} />);
}

beforeEach(() => {
    h.contextFolder = "";
    h.context = { id: "client", name: "Client: SEFERS", emblem: "briefcase" };
});

// #2518: one Folder line, then one sentence, and the ribbon of the context the workspace is in.
describe("the workspace's Folder line", () => {
    it("holds the chosen folder, Change… and Reset, and says where its panels stay, in which context", () => {
        h.contextFolder = "/clients/sefers";
        const html = line(chosen("/clients/sefers/echanges"));
        expect(html).toContain('data-folder-kind="chosen"');
        expect(html).toMatch(/data-testid="workspace-folder"[^>]*>\/clients\/sefers\/echanges</);
        expect(html).toContain("Change…");
        expect(html).toContain(">Reset<");
        expect(html).toContain(
            "The panels of this workspace stay in this folder, and new ones start there. In the context"
        );
        expect(html).toMatch(/data-testid="folder-context-ribbon"[\s\S]*mt-ribbon-name">Client: SEFERS</);
        expect(html.toLowerCase()).toContain("--ribbon-paint:#e07a36");
        expect(html).not.toContain("Inherited from the context");
    });

    it("shows where the folder comes from when none is chosen, and hides Reset", () => {
        h.contextFolder = "/clients/sefers";
        const html = line(workspace({ [WorkspaceFolderMetaKey]: "/Users/me" }));
        expect(html).toContain('data-folder-kind="inherited"');
        expect(html).toContain("Inherited from the context: /clients/sefers");
        expect(html).not.toContain(">Reset<");
        expect(html).toContain("Change…");
        expect(html).toContain("In the context");
        expect(html).toContain('mt-ribbon-name">Client: SEFERS<');
    });

    it("has no workspace title and no chain: the folder's path stands alone on its line", () => {
        h.contextFolder = "/clients/sefers";
        const html = line(chosen("/clients/sefers/echanges"));
        expect(html).not.toContain(">echanges<");
        expect(html).not.toContain("data-chain");
    });

    it("keeps what it said before when the context sets no folder", () => {
        const none = line(workspace({}));
        expect(none).toContain('data-folder-kind="none"');
        expect(none).toContain("Not set yet");
        expect(none).toContain("Set by the next folder your terminal goes to");
        expect(none).not.toContain(">Reset<");
        expect(none).not.toContain("mt-ribbon-shape");

        const followed = line(workspace({ [WorkspaceFolderMetaKey]: "/tmp/x" }));
        expect(followed).toContain('data-folder-kind="followed"');
        expect(followed).toContain("/tmp/x");
        expect(followed).toContain("New terminals, views and files start here.");
        expect(followed).toContain(">Reset<");
        expect(followed).not.toContain("mt-ribbon-shape");
    });

    it("says a followed folder outside the project falls back to the project's root", () => {
        const html = line(workspace({ [WorkspaceFolderMetaKey]: "/tmp", [ProjectMetaKey]: "/p/app" }));
        expect(html).toContain("Outside the project: new panels start at its root.");
    });

    it("names the first context's own language name for a context that has none", () => {
        h.contextFolder = "/c";
        h.context = { id: "workshop", emblem: "hammer" };
        expect(line(workspace({}))).toContain('mt-ribbon-name">My workshop<');
    });
});

describe("a linked project outside the folder that bounds its workspace", () => {
    it("is marked, and the others are not", () => {
        const inside = renderToStaticMarkup(
            <WorkspaceProjectBlock ws={chosen("/c/w", { [ProjectMetaKey]: "/c/w/app" })} />
        );
        expect(inside).not.toContain("project-outside-folder");
        const outside = renderToStaticMarkup(
            <WorkspaceProjectBlock ws={chosen("/c/w", { [ProjectMetaKey]: "/c/other" })} />
        );
        expect(outside).toContain('data-testid="project-outside-folder"');
        expect(outside).toContain("outside the folder");
        h.contextFolder = "/c";
        const byContext = renderToStaticMarkup(
            <WorkspaceProjectBlock ws={workspace({ [ProjectMetaKey]: "/q/app" })} />
        );
        expect(byContext).toContain("project-outside-folder");
    });
});

// #2518: the question asked when a folder chosen for a workspace is outside its context's.
describe("the folder outside its context", () => {
    const dialog = () =>
        renderToStaticMarkup(
            <FolderOutsideDialog
                contextName="Client: SEFERS"
                contextFolder="/clients/sefers"
                onUse={() => {}}
                onChooseAnother={() => {}}
                onCancel={() => {}}
            />
        );

    it("names the context and the folder the panels will be able to leave", () => {
        const html = dialog();
        expect(html).toContain('data-role="workspace-folder-outside"');
        expect(html).toContain("This folder is outside the context “Client: SEFERS”");
        expect(html).toContain("The panels of this workspace will be able to leave the folder of the context:");
        expect(html).toContain("/clients/sefers");
    });

    it("offers to use the folder or to choose another, the safe answer first, the call to action molten", () => {
        const html = dialog();
        expect(html).toMatch(/data-testid="folder-outside-another"[^>]*>Choose another folder</);
        expect(html).toMatch(/data-testid="folder-outside-use"[^>]*>Use this folder</);
        expect(html.indexOf("folder-outside-another")).toBeLessThan(html.indexOf("folder-outside-use"));
        expect(html).toMatch(/class="molten-btn [^"]*"[^>]*data-testid="folder-outside-use"/);
    });
});
