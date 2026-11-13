// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The project card's work (FR-BOSS-010 AC15, #2250). wavesrv previews and makes the folder (pkg/molten/brainstorm/
// project.go): this model asks it, then links the folder to the workspace the developer picked, a new one through the
// sidebar's own creation (workspace-create.ts) or an existing one (linkWorkspaceProject), and tells wavesrv which. Each
// step is the developer's click; nothing is remembered as an approval. The parent folder they choose is remembered in
// boss:projectsdir, a convenience for the next project.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { freshColour } from "../sidebar/sidebar-create-model";
import { switchFromSidebar } from "../sidebar/sidebar-switch";
import { createWorkspace, WorkspaceDraft } from "../workspace-create";
import { chooseMoltentermPath, linkWorkspaceProject } from "../workspace-project-store";
import { isSavedWorkspace } from "../workspace-rail-model";
import {
    BrainstormRouteId,
    BrainstormState,
    CallTimeoutMs,
    ProjectCreateCommand,
    ProjectLinkedCommand,
    ProjectPreviewCommand,
} from "./brainstorm-boot";
import type { ProjectBrief } from "./brainstorm-brief-model";
import {
    choiceAmong,
    ProjectFailure,
    ProjectPreview,
    projectRequest,
    ProjectResult,
    WorkspaceChoice,
    WorkspaceOption,
} from "./brainstorm-project-model";
import { BrainstormModel } from "./brainstorm-store";

export const ProjectsDirKey = "boss:projectsdir";

// A folder name typed: the preview follows once the typing pauses.
const PreviewDelayMs = 250;
// The folder and git run in wavesrv: past its own 30 s, the call gives up too.
const CreateTimeoutMs = 45000;

type Call = (command: string, data: Record<string, unknown>, timeout: number) => Promise<any>;

export type ProjectDeps = {
    call: Call;
    createWorkspace: (draft: WorkspaceDraft) => Promise<string>;
    linkWorkspace: (workspaceId: string, dir: string) => Promise<void>;
    listWorkspaces: () => Promise<WorkspaceOption[]>;
    chooseFolder: (title: string, defaultPath: string) => Promise<string>;
    rememberParent: (parent: string) => Promise<void>;
    reveal: (dir: string) => void;
    switchTo: (workspaceId: string) => void;
    currentWorkspace: () => string;
};

async function liveWorkspaces(): Promise<WorkspaceOption[]> {
    const rtn: WorkspaceOption[] = [];
    for (const entry of (await WorkspaceService.ListWorkspaces()) ?? []) {
        const ws = await WorkspaceService.GetWorkspace(entry.workspaceid);
        if (ws == null || !isSavedWorkspace(ws)) {
            continue;
        }
        rtn.push({ id: ws.oid, name: ws.name, colour: ws.color });
    }
    return rtn;
}

const LiveDeps: ProjectDeps = {
    call: (command, data, timeout) => TabRpcClient.wshRpcCall(command, data, { route: BrainstormRouteId, timeout }),
    createWorkspace,
    linkWorkspace: async (workspaceId, dir) => {
        await linkWorkspaceProject({ oid: workspaceId } as Workspace, dir);
    },
    listWorkspaces: liveWorkspaces,
    chooseFolder: (title, defaultPath) =>
        chooseMoltentermPath({ kind: "folder", title, defaultPath: defaultPath || undefined }),
    rememberParent: async (parent) => {
        await RpcApi.SetConfigCommand(TabRpcClient, { [ProjectsDirKey]: parent } as SettingsType);
    },
    reveal: (dir) => getApi().revealNativePath(dir),
    switchTo: (workspaceId) => switchFromSidebar(workspaceId, 1),
    currentWorkspace: () => globalStore.get(atoms.workspace)?.oid ?? "",
};

export class BrainstormProjectModel {
    private static instance: BrainstormProjectModel = null;

    previewAtom = atom(null) as PrimitiveAtom<ProjectPreview>;
    // What the developer typed for the folder's name ("" keeps the brief's slug) and the parent folder they chose on
    // this card ("" keeps boss:projectsdir).
    nameAtom = atom("") as PrimitiveAtom<string>;
    parentAtom = atom("") as PrimitiveAtom<string>;
    choiceAtom = atom({ kind: "new" }) as PrimitiveAtom<WorkspaceChoice>;
    workspacesAtom = atom([]) as PrimitiveAtom<WorkspaceOption[]>;
    busyAtom = atom(false) as PrimitiveAtom<boolean>;
    failureAtom = atom(null) as PrimitiveAtom<ProjectFailure>;
    // The card folded to its eyebrow, so the graph behind it shows whole.
    foldedAtom = atom(false) as PrimitiveAtom<boolean>;

    private deps: ProjectDeps = LiveDeps;
    // The brainstorm the card's inputs are of: another one starts them over.
    private of: string = null;
    private previewSeq = 0;
    private previewTimer: ReturnType<typeof setTimeout> = null;

    private constructor() {}

    static getInstance(): BrainstormProjectModel {
        if (BrainstormProjectModel.instance == null) {
            BrainstormProjectModel.instance = new BrainstormProjectModel();
        }
        return BrainstormProjectModel.instance;
    }

    static resetInstance(): void {
        BrainstormProjectModel.instance = null;
    }

    useDeps(deps: Partial<ProjectDeps>): void {
        this.deps = { ...this.deps, ...deps };
    }

    private state(): BrainstormState {
        return globalStore.get(BrainstormModel.getInstance().stateAtom);
    }

    private brainstormOf(): { swap: number; id: string } {
        const state = this.state();
        return { swap: state?.swap, id: state?.brainstorm?.id ?? "" };
    }

    private brief(): ProjectBrief {
        return this.state()?.brief ?? null;
    }

    private async ask(command: string, data: Record<string, unknown>, timeout = CallTimeoutMs): Promise<any> {
        try {
            return await this.deps.call(command, data, timeout);
        } catch (e) {
            console.log("brainstorm: wavesrv did not answer", command, e);
            return null;
        }
    }

    // The card shows for this brainstorm: its inputs start over when it is another one, and the preview follows.
    async show(): Promise<void> {
        const id = this.state()?.brainstorm?.id ?? "";
        if (id !== this.of) {
            this.of = id;
            globalStore.set(this.nameAtom, "");
            globalStore.set(this.parentAtom, "");
            globalStore.set(this.choiceAtom, { kind: "new" });
            globalStore.set(this.failureAtom, null);
            globalStore.set(this.previewAtom, null);
            globalStore.set(this.foldedAtom, false);
        }
        await Promise.all([this.refreshWorkspaces(), this.refreshPreview()]);
    }

    toggleFold(): void {
        globalStore.set(this.foldedAtom, (folded) => !folded);
    }

    async refreshWorkspaces(): Promise<void> {
        try {
            const list = await this.deps.listWorkspaces();
            globalStore.set(this.workspacesAtom, list ?? []);
            globalStore.set(this.choiceAtom, choiceAmong(globalStore.get(this.choiceAtom), list ?? []));
        } catch (e) {
            console.log("brainstorm: the workspaces could not be listed", e);
        }
    }

    // The preview of what the click will make: wavesrv checks the path and says why it cannot be made. A preview asked
    // later replaces one still coming.
    async refreshPreview(): Promise<void> {
        const brief = this.brief();
        if (brief == null) {
            return;
        }
        const seq = ++this.previewSeq;
        const request = projectRequest(globalStore.get(this.parentAtom), globalStore.get(this.nameAtom), brief.slug);
        const result: ProjectResult = await this.ask(ProjectPreviewCommand, { ...request, ...this.brainstormOf() });
        if (seq !== this.previewSeq || result == null || result.stale) {
            return;
        }
        if (result.error) {
            globalStore.set(this.failureAtom, result.error as ProjectFailure);
            return;
        }
        globalStore.set(this.previewAtom, result.preview ?? null);
        // A new preview says what holds now; a workspace not linked yet is still to link.
        if (globalStore.get(this.failureAtom) !== "link") {
            globalStore.set(this.failureAtom, null);
        }
    }

    setName(name: string): void {
        globalStore.set(this.nameAtom, name);
        globalStore.set(this.failureAtom, null);
        clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => void this.refreshPreview(), PreviewDelayMs);
    }

    choose(choice: WorkspaceChoice): void {
        globalStore.set(this.choiceAtom, choice);
    }

    // Change…: the parent folder, chosen in the system's dialog, is remembered for the next project.
    async chooseParent(title: string): Promise<void> {
        const current = globalStore.get(this.previewAtom)?.parent ?? "";
        const dir = await this.deps.chooseFolder(title, current);
        if (!dir) {
            return;
        }
        globalStore.set(this.parentAtom, dir);
        globalStore.set(this.failureAtom, null);
        try {
            await this.deps.rememberParent(dir);
        } catch (e) {
            console.log("brainstorm: the projects folder could not be remembered", e);
        }
        await this.refreshPreview();
    }

    // The click (AC15): wavesrv makes the folder, starts git and writes the copy, then the workspace is linked. A
    // refusal says why and makes nothing; Try again asks the preview again.
    async create(): Promise<boolean> {
        const brief = this.brief();
        if (brief == null || globalStore.get(this.busyAtom)) {
            return false;
        }
        globalStore.set(this.busyAtom, true);
        globalStore.set(this.failureAtom, null);
        try {
            const request = projectRequest(
                globalStore.get(this.parentAtom),
                globalStore.get(this.nameAtom),
                brief.slug
            );
            const result: ProjectResult = await this.ask(
                ProjectCreateCommand,
                { ...request, ...this.brainstormOf() },
                CreateTimeoutMs
            );
            if (result == null) {
                globalStore.set(this.failureAtom, "failed");
                return false;
            }
            BrainstormModel.getInstance().apply(result.state);
            if (result.stale) {
                return false;
            }
            if (result.error || !result.dir) {
                globalStore.set(this.previewAtom, result.preview ?? globalStore.get(this.previewAtom));
                globalStore.set(this.failureAtom, (result.error || "failed") as ProjectFailure);
                return false;
            }
            return await this.linkFolder(result.dir, brief);
        } finally {
            globalStore.set(this.busyAtom, false);
        }
    }

    // Try again after the folder was made but its workspace was not linked.
    async link(dir: string): Promise<boolean> {
        const brief = this.brief();
        if (brief == null || !dir || globalStore.get(this.busyAtom)) {
            return false;
        }
        globalStore.set(this.busyAtom, true);
        globalStore.set(this.failureAtom, null);
        try {
            return await this.linkFolder(dir, brief);
        } finally {
            globalStore.set(this.busyAtom, false);
        }
    }

    private async linkFolder(dir: string, brief: ProjectBrief): Promise<boolean> {
        const workspaces = globalStore.get(this.workspacesAtom);
        const choice = choiceAmong(globalStore.get(this.choiceAtom), workspaces);
        let workspaceId: string;
        try {
            if (choice.kind === "existing") {
                await this.deps.linkWorkspace(choice.id, dir);
                workspaceId = choice.id;
            } else {
                const colour = freshColour(
                    workspaces.map((w) => w.colour ?? ""),
                    workspaces.length
                );
                workspaceId = await this.deps.createWorkspace({ name: brief.name, colour, folder: dir });
            }
        } catch (e) {
            console.log("brainstorm: the project's workspace could not be linked", e);
            globalStore.set(this.failureAtom, "link");
            return false;
        }
        const linked = await this.ask(ProjectLinkedCommand, { ...this.brainstormOf(), dir, workspace: workspaceId });
        BrainstormModel.getInstance().apply(linked?.state);
        void this.refreshWorkspaces();
        return true;
    }

    showFolder(dir: string): void {
        if (!dir) {
            return;
        }
        try {
            this.deps.reveal(dir);
        } catch (e) {
            console.log("brainstorm: the folder could not be shown", e);
        }
    }

    // Go to the workspace: the brainstorm is left first, so the workspace shows with nothing over it.
    async goTo(workspaceId: string): Promise<void> {
        await BrainstormModel.getInstance().end();
        if (workspaceId && workspaceId !== this.deps.currentWorkspace()) {
            this.deps.switchTo(workspaceId);
        }
    }
}
