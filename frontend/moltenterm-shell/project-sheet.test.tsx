// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { current } = vi.hoisted(() => ({ current: { ws: null as Workspace } }));

vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    useWaveObjectValue: () => [current.ws, false],
}));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom(null) }, getApi: () => ({ getDataDir: () => "/data" }) };
});
vi.mock("@/app/store/services", () => ({ WorkspaceService: {} }));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://localhost" }));
vi.mock("./workspace-edit", () => ({ openProjectSheet: () => {} }));
vi.mock("./workspace-reset", () => ({ askResetWorkspace: () => {}, askDeleteWorkspace: () => {} }));
vi.mock("./open-view", () => ({ openMoltentermView: async () => {} }));
vi.mock("./coding-agent/coding-agent", async () => {
    const { atom } = await import("jotai");
    const choicesAtom = atom({
        "/code/desk": {
            choice: {
                global: "codex",
                agents: [
                    { id: "claude", name: "Claude Code", installed: true },
                    { id: "codex", name: "Codex", installed: true },
                ],
            },
            at: 0,
        },
    });
    return {
        CodingAgentIds: ["claude", "codex"],
        codingAgentName: (id: string) => (id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : id),
        CodingAgentModel: { getInstance: () => ({ choicesAtom, refresh: () => {} }) },
        rememberedProjectAgent: (dir: string) => (dir === "/code/desk" ? "claude" : undefined),
        rememberProjectAgent: async () => {},
    };
});
vi.mock("./sidebar/sidebar-store", async () => {
    const { atom } = await import("jotai");
    const enabledAtom = atom(false);
    return { SidebarModel: { getInstance: () => ({ enabledAtom }) } };
});
vi.mock("./sidebar/workspace-projects-edit-store", () => ({
    editWorkspaceProject: async () => {},
    removeWorkspaceProject: async () => {},
}));
vi.mock("./workspace-project-store", () => ({
    chooseMoltentermPath: async () => null,
    findProjectLogos: async () => [],
    linkWorkspaceProject: async () => "",
    readProjectFacts: async () => null,
    setProjectLogo: async () => {},
    setWorkspaceLogo: async () => {},
    setWorkspaceGradient: async () => {},
    unlinkWorkspaceProject: async () => {},
}));
vi.mock("./workspace-project-section", () => ({
    WorkspaceProjectBlock: () => <div data-stub="project">Link a project…</div>,
    WorkspaceFolderLine: () => <div data-stub="folder">Change…</div>,
}));
vi.mock("./window-look-field", () => ({ OpacityField: () => null, useLookScope: () => "workspace" }));
vi.mock("./dialog-frame", () => ({
    useEscape: () => {},
    DialogFrame: ({ role, title, subtitle, children, buttons }: any) => (
        <div role="dialog" aria-label={title} data-role={role}>
            <div data-subtitle="">{subtitle}</div>
            {children}
            {buttons}
        </div>
    ),
}));

import { projectExit, ProjectSheet, sheetProject } from "./project-sheet";

const base = { oid: "w1", name: "Client A", icon: "rocket", color: "#429DFF" };
const twoProjects = {
    ...base,
    meta: {
        "molten:project": "/code/desk",
        "molten:projecttype": "Desktop",
        "molten:projectlogo": "/code/desk/icon.png",
        "molten:currentproject": "p2",
        "molten:projects": [
            { id: "p1", type: "Website", dir: "/code/site", branch: "main" },
            { id: "p2", type: "Desktop", dir: "/code/desk", branch: "develop" },
        ],
    },
} as any as Workspace;

function render(ws: Workspace, projectId?: string) {
    current.ws = ws;
    return renderToStaticMarkup(
        <ProjectSheet workspaceId="w1" projectId={projectId} onBack={() => {}} onClose={() => {}} />
    );
}

function blocks(html: string): { block: string; title: string; scope: string }[] {
    return html
        .split(/<section /)
        .slice(1)
        .map((s) => ({
            block: /data-block="([^"]+)"/.exec(s)?.[1],
            title: /<h3 id="[^"]+"[^>]*>([^<]+)<\/h3>/.exec(s)?.[1],
            scope: /data-scope="([^"]+)"/.exec(s)?.[1],
        }));
}

describe("the Project sheet (FR-SHELL-105)", () => {
    it("holds the project's folder, type and branch, logo, pipeline and agent, every block for this project", () => {
        const html = render(twoProjects);
        expect(html).toContain('aria-label="Set up the project"');
        expect(html).toContain('data-role="project-sheet"');
        expect(blocks(html)).toEqual([
            { block: "repository", title: "Repository and folder", scope: "project" },
            { block: "details", title: "Type and branch", scope: "project" },
            { block: "logo", title: "Logo", scope: "project" },
            { block: "pipeline", title: "Pipeline and CI", scope: "project" },
            { block: "agent", title: "Project&#x27;s agent", scope: "project" },
        ]);
        expect(html).toContain("For this project");
    });

    it("shows the current project by default, and the asked one otherwise", () => {
        expect(render(twoProjects)).toContain("/code/desk");
        const site = render(twoProjects, "p1");
        expect(site).toContain("/code/site");
        expect(site).toMatch(/value="Website"/);
        expect(site).toMatch(/value="main"/);
        expect(sheetProject(twoProjects, "gone").id).toBe("p2");
    });

    it("edits the type and the followed branch in labelled fields", () => {
        const html = render(twoProjects);
        expect(html).toMatch(/<label for="([^"]+)"[^>]*>Type<\/label><input id="\1"[^>]*value="Desktop"/);
        expect(html).toMatch(/<label for="([^"]+)"[^>]*>Branch followed<\/label><input id="\1"[^>]*value="develop"/);
    });

    it("removes a project from a workspace of several, and unlinks the only one", () => {
        expect(projectExit(2)).toBe("remove");
        expect(projectExit(1)).toBe("unlink");
        expect(render(twoProjects)).toContain('data-action="project-remove"');
        const one = { ...base, meta: { "molten:project": "/code/desk" } } as any as Workspace;
        expect(render(one)).toContain('data-action="project-unlink"');
    });

    it("says whether the workspace's icon shows the project's logo", () => {
        expect(render(twoProjects)).toContain("The workspace&#x27;s icon shows this logo.");
        const own = { ...twoProjects, meta: { ...twoProjects.meta, "molten:projectlogo": "" } } as any as Workspace;
        expect(render(own)).toContain("turn on “Use the project&#x27;s logo” in its Identity");
    });

    it("offers the app's default agent and each agent, this project's choice selected", () => {
        const html = render(twoProjects);
        const options = [...html.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => [
            m[2],
            m[1],
        ]);
        expect(options).toEqual([
            ["App default (Codex)", "false"],
            ["Claude Code", "true"],
            ["Codex", "false"],
        ]);
    });

    it("keeps only the folder, type and branch for a project without a folder", () => {
        const typed = {
            ...base,
            meta: { "molten:projects": [{ id: "p1", type: "Mobile", dir: "" }], "molten:projecttype": "Mobile" },
        } as any as Workspace;
        expect(blocks(render(typed)).map((b) => b.block)).toEqual(["repository", "details"]);
        expect(render(typed)).toContain("No folder yet");
    });

    it("offers the link when the workspace has no project, and always the way back to the workspace", () => {
        const html = render({ ...base, meta: {} } as any as Workspace);
        expect(html).toContain('data-stub="project"');
        expect(html).toMatch(/data-action="back-to-workspace"[^>]*>‹ Workspace</);
        expect(render(twoProjects)).toMatch(/<button type="button" class="molten-btn cursor-pointer[^"]*">Done/);
    });
});
