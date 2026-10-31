// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
    chooseMoltentermPath: vi.fn(),
    setWorkspaceFolder: vi.fn(),
    linkWorkspaceProject: vi.fn(),
    readProjectFacts: vi.fn(),
    updateWorkspace: vi.fn(),
    onboardingUpdate: vi.fn(),
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "ws1", icon: "" }) },
        getApi: () => ({ setActiveTab: vi.fn() }),
        replaceBlock: vi.fn(),
    };
});
vi.mock("@/app/store/jotaiStore", async () => {
    const { createStore } = await import("jotai");
    return { globalStore: createStore() };
});
vi.mock("@/app/store/keymodel", () => ({ uxCloseBlock: vi.fn() }));
vi.mock("@/app/store/services", () => ({
    WorkspaceService: { UpdateWorkspace: store.updateWorkspace, AddWorkspaceViews: vi.fn(async () => "") },
}));
vi.mock("@/app/store/tab-model", () => ({ getActiveTabModel: () => null }));
vi.mock("@/app/element/errorboundary", () => ({ ErrorBoundary: () => null }));
vi.mock("../moltenterm-shell/workspace-project-store", () => ({
    chooseMoltentermPath: store.chooseMoltentermPath,
    setWorkspaceFolder: store.setWorkspaceFolder,
    linkWorkspaceProject: store.linkWorkspaceProject,
    readProjectFacts: store.readProjectFacts,
}));
vi.mock("./onboarding-client", () => ({
    currentOnboardingState: () => ({}),
    ensureMorphDir: vi.fn(),
    listOnboardingAgents: vi.fn(),
    onboardingUpdate: store.onboardingUpdate,
}));
vi.mock("./onboarding-pour", () => ({ OnboardingPour: () => null }));

import { globalStore } from "@/app/store/jotaiStore";
import { OnboardingViewModel } from "./onboarding-view";

describe("Open my project (#1642)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        store.readProjectFacts.mockResolvedValue({ name: "notes" });
    });

    it("links a folder without git as the workspace's project", async () => {
        store.chooseMoltentermPath.mockResolvedValue("/tmp/notes");
        store.linkWorkspaceProject.mockResolvedValue("/tmp/notes");
        const model = new OnboardingViewModel({ blockId: "b1", nodeModel: null } as any);
        await model.openProject();
        expect(globalStore.get(model.errorAtom)).toBeNull();
        expect(store.setWorkspaceFolder).toHaveBeenCalledWith("ws1", "/tmp/notes");
        expect(store.linkWorkspaceProject).toHaveBeenCalledWith(expect.objectContaining({ oid: "ws1" }), "/tmp/notes");
        expect(store.readProjectFacts).toHaveBeenCalledWith("/tmp/notes");
    });

    it("names the workspace after the repository root the folder sits in", async () => {
        store.chooseMoltentermPath.mockResolvedValue("/src/app/web");
        store.linkWorkspaceProject.mockResolvedValue("/src/app");
        const model = new OnboardingViewModel({ blockId: "b1", nodeModel: null } as any);
        await model.openProject();
        expect(globalStore.get(model.errorAtom)).toBeNull();
        expect(store.readProjectFacts).toHaveBeenCalledWith("/src/app");
    });

    it("leaves the workspace alone when the folder choice is cancelled", async () => {
        store.chooseMoltentermPath.mockResolvedValue("");
        const model = new OnboardingViewModel({ blockId: "b1", nodeModel: null } as any);
        await model.openProject();
        expect(globalStore.get(model.errorAtom)).toBeNull();
        expect(store.setWorkspaceFolder).not.toHaveBeenCalled();
        expect(store.linkWorkspaceProject).not.toHaveBeenCalled();
    });
});
