// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first run's work behind the pour (#1642, #1709): the project scene creates or links the project, the last
// scene makes the first view, and Later or Skip make none.

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
    chooseMoltentermPath: vi.fn(),
    setWorkspaceFolder: vi.fn(),
    linkWorkspaceProject: vi.fn(),
    readProjectFacts: vi.fn(),
    updateWorkspace: vi.fn(),
    onboardingUpdate: vi.fn(),
    fileInfo: vi.fn(),
    mkdir: vi.fn(),
    gitInit: vi.fn(),
    createView: vi.fn(),
    setActiveTab: vi.fn(),
    closeTab: vi.fn(),
    replaceBlock: vi.fn(),
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "ws1", icon: "", name: "Starter workspace" }) },
        getApi: () => ({ setActiveTab: store.setActiveTab, closeTab: store.closeTab, getHomeDir: () => "/Users/ada" }),
        replaceBlock: store.replaceBlock,
    };
});
vi.mock("@/app/store/jotaiStore", async () => {
    const { createStore } = await import("jotai");
    return { globalStore: createStore() };
});
vi.mock("@/app/store/keymodel", () => ({ uxCloseBlock: vi.fn() }));
vi.mock("@/app/store/services", () => ({ WorkspaceService: { UpdateWorkspace: store.updateWorkspace } }));
vi.mock("@/app/store/tab-model", async () => {
    const { atom } = await import("jotai");
    const tabAtom = atom({ oid: "tab1", blockids: ["b1"] });
    return { getActiveTabModel: () => ({ tabAtom }) };
});
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { FileInfoCommand: store.fileInfo, FileMkdirCommand: store.mkdir },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/element/errorboundary", () => ({ ErrorBoundary: () => null }));
vi.mock("../moltenterm-shell/mission/mission-client", () => ({ missionGitInit: store.gitInit }));
vi.mock("../moltenterm-shell/sidebar/view-pins-store", () => ({
    ViewPins: { getInstance: () => ({ createView: store.createView }) },
}));
vi.mock("../moltenterm-shell/workspace-project-store", () => ({
    chooseMoltentermPath: store.chooseMoltentermPath,
    setWorkspaceFolder: store.setWorkspaceFolder,
    linkWorkspaceProject: store.linkWorkspaceProject,
    readProjectFacts: store.readProjectFacts,
}));
vi.mock("./onboarding-client", () => ({
    listOnboardingAgents: vi.fn(),
    scanProjectCandidates: vi.fn(async () => []),
    onboardingUpdate: store.onboardingUpdate,
}));
vi.mock("./onboarding-pour", () => ({ OnboardingPour: () => null }));

import { globalStore } from "@/app/store/jotaiStore";
import { OnboardingViewModel } from "./onboarding-view";

const newDraft = { mode: "new" as const, name: "atlas", location: "/Users/ada/Projets", git: true, found: "" };
const findDraft = { mode: "find" as const, name: "", location: "", git: true, found: "/tmp/notes" };

function model() {
    return new OnboardingViewModel({ blockId: "b1", nodeModel: null } as any);
}

describe("the project scene (FR-ONB-007 P-4, #1642)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        store.readProjectFacts.mockResolvedValue({ name: "atlas" });
        store.fileInfo.mockResolvedValue({ notfound: true });
        store.gitInit.mockResolvedValue({});
    });

    it("creates the new folder with git and links it as the workspace's project (TC-ONB-015)", async () => {
        store.linkWorkspaceProject.mockResolvedValue("/Users/ada/Projets/atlas");
        const m = model();
        const result = await m.leaveProject(newDraft);
        expect(globalStore.get(m.errorAtom)).toBeNull();
        expect(store.mkdir).toHaveBeenCalledWith({}, { info: { path: "/Users/ada/Projets/atlas" } });
        expect(store.gitInit).toHaveBeenCalledWith("/Users/ada/Projets/atlas");
        expect(store.setWorkspaceFolder).toHaveBeenCalledWith("ws1", "/Users/ada/Projets/atlas");
        expect(store.updateWorkspace).toHaveBeenCalledWith("ws1", "atlas", "", expect.any(String), true);
        expect(result).toMatchObject({ name: "atlas", path: "~/Projets/atlas" });
        expect(store.onboardingUpdate).toHaveBeenCalledWith({ kind: "step", step: "project", status: "done" });
    });

    it("leaves git out when unchecked, and links nothing twice when nothing changed", async () => {
        store.linkWorkspaceProject.mockResolvedValue("/Users/ada/Projets/atlas");
        const m = model();
        await m.leaveProject({ ...newDraft, git: false });
        expect(store.gitInit).not.toHaveBeenCalled();
        await m.leaveProject({ ...newDraft, git: false });
        expect(store.mkdir).toHaveBeenCalledTimes(1);
    });

    it("refuses a name already taken there, in plain words, and stays", async () => {
        store.fileInfo.mockResolvedValue({ name: "atlas", isdir: true });
        const m = model();
        expect(await m.leaveProject(newDraft)).toBeNull();
        expect(globalStore.get(m.errorAtom)).toContain("atlas");
        expect(store.mkdir).not.toHaveBeenCalled();
        expect(store.setWorkspaceFolder).not.toHaveBeenCalled();
    });

    it("links a folder found, without git, as the workspace's project", async () => {
        store.linkWorkspaceProject.mockResolvedValue("/tmp/notes");
        store.readProjectFacts.mockResolvedValue({ name: "notes" });
        const m = model();
        await m.leaveProject(findDraft);
        expect(store.mkdir).not.toHaveBeenCalled();
        expect(store.gitInit).not.toHaveBeenCalled();
        expect(store.linkWorkspaceProject).toHaveBeenCalledWith(expect.objectContaining({ oid: "ws1" }), "/tmp/notes");
        expect(store.readProjectFacts).toHaveBeenCalledWith("/tmp/notes");
    });

    it("names the workspace after the repository root the folder sits in", async () => {
        store.linkWorkspaceProject.mockResolvedValue("/src/app");
        const m = model();
        await m.leaveProject({ ...findDraft, found: "/src/app/web" });
        expect(store.readProjectFacts).toHaveBeenCalledWith("/src/app");
    });

    it("records Later as the project step skipped", async () => {
        const m = model();
        m.laterProject();
        await vi.waitFor(() =>
            expect(store.onboardingUpdate).toHaveBeenCalledWith({ kind: "step", step: "project", status: "skipped" })
        );
    });
});

describe("the end of the run (FR-ONB-009)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        store.createView.mockResolvedValue("view-tab");
    });

    it("makes exactly one view, pinned where chosen, and shows it in place of the panel", async () => {
        const m = model();
        await m.start({
            panels: ["agent", "browser", "files"],
            agentId: "codex",
            name: "",
            nameKey: "workspaceViews.names.scoping",
            place: "everywhere",
        });
        expect(globalStore.get(m.errorAtom)).toBeNull();
        expect(store.createView).toHaveBeenCalledTimes(1);
        const req = store.createView.mock.calls[0][0];
        expect(req).toMatchObject({ scope: "everywhere", nameKey: "workspaceViews.names.scoping", background: true });
        expect(req.config.panes[0]).toMatchObject({ view: "term", "molten:agentslot": true, "molten:slotagent": "codex" });
        expect(store.onboardingUpdate).toHaveBeenCalledWith({ kind: "finish" });
        expect(store.setActiveTab).toHaveBeenCalledWith("view-tab");
        expect(store.closeTab).toHaveBeenCalledWith("ws1", "tab1", false);
    });

    it("makes no view after Later, and leaves a terminal in place of the panel", async () => {
        const m = model();
        await m.start(null);
        expect(store.createView).not.toHaveBeenCalled();
        expect(store.onboardingUpdate).toHaveBeenCalledWith({ kind: "step", step: "view", status: "skipped" });
        expect(store.replaceBlock).toHaveBeenCalled();
        expect(store.closeTab).not.toHaveBeenCalled();
    });

    it("makes no view on Skip", async () => {
        const m = model();
        await m.leave();
        expect(store.createView).not.toHaveBeenCalled();
        expect(store.onboardingUpdate).toHaveBeenCalledWith({ kind: "leave" });
    });
});
