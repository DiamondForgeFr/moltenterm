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
import { readWorkspaceProject } from "../workspace-project";
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
    expectOf,
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
    createWorkspace: (draft: WorkspaceDraft, onCreated?: (id: string) => void) => Promise<string>;
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
        rtn.push({ id: ws.oid, name: ws.name, colour: ws.color, project: readWorkspaceProject(ws).dir });
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
    // The workspace made for a project folder whose link did not go through: Try again links that one, never a second.
    private madeWorkspace: { dir: string; id: string } = null;
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
        // A new preview says what holds now (a folder made by a click wavesrv did not answer shows as not empty); a
        // workspace not linked yet is still to link.
        if (globalStore.get(this.failureAtom) !== "link") {
            globalStore.set(this.failureAtom, null);
        }
    }

    // A name typed: the preview of the name before goes at once, so the click waits for the one of this name (AC-2).
    setName(name: string): void {
        globalStore.set(this.nameAtom, name);
        globalStore.set(this.failureAtom, null);
        globalStore.set(this.previewAtom, null);
        this.previewSeq++;
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
        globalStore.set(this.previewAtom, null);
        this.previewSeq++;
        try {
            await this.deps.rememberParent(dir);
        } catch (e) {
            console.log("brainstorm: the projects folder could not be remembered", e);
        }
        await this.refreshPreview();
    }

    // The click (AC15): wavesrv makes the folder, starts git and writes the copy, then the workspace is linked. It sends
    // the preview the developer saw, and wavesrv acts only on that path: when it no longer holds (stale), nothing is made
    // and the card previews again. A refusal says why and makes nothing; Try again asks the preview again.
    async create(): Promise<boolean> {
        const brief = this.brief();
        const seen = globalStore.get(this.previewAtom);
        if (brief == null || seen?.path == null || seen.path === "" || globalStore.get(this.busyAtom)) {
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
                { ...request, ...this.brainstormOf(), expect: expectOf(seen) },
                CreateTimeoutMs
            );
            if (result == null) {
                // No answer: wavesrv may have made it or not. The card never says nothing was made; it offers to look.
                globalStore.set(this.failureAtom, "unknown");
                void BrainstormModel.getInstance().refresh();
                return false;
            }
            BrainstormModel.getInstance().apply(result.state);
            if (result.stale) {
                globalStore.set(this.previewAtom, null);
                void this.refreshPreview();
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

    // Links the project folder to the chosen workspace, then tells wavesrv which. A workspace made for this folder before
    // a step failed is linked again, never made twice; wavesrv's no or its silence is a failed link too, so that Try
    // again is offered and promotedto never stays empty without a word.
    private async linkFolder(dir: string, brief: ProjectBrief): Promise<boolean> {
        const workspaces = globalStore.get(this.workspacesAtom);
        const choice = choiceAmong(globalStore.get(this.choiceAtom), workspaces);
        const made = this.madeWorkspace?.dir === dir ? this.madeWorkspace.id : "";
        let workspaceId: string;
        try {
            if (made !== "") {
                await this.deps.linkWorkspace(made, dir);
                workspaceId = made;
            } else if (choice.kind === "existing") {
                await this.deps.linkWorkspace(choice.id, dir);
                workspaceId = choice.id;
            } else {
                const colour = freshColour(
                    workspaces.map((w) => w.colour ?? ""),
                    workspaces.length
                );
                workspaceId = await this.deps.createWorkspace({ name: brief.name, colour, folder: dir }, (id) => {
                    this.madeWorkspace = { dir, id };
                });
            }
        } catch (e) {
            console.log("brainstorm: the project's workspace could not be linked", e);
            globalStore.set(this.failureAtom, "link");
            return false;
        }
        const linked = await this.ask(ProjectLinkedCommand, { ...this.brainstormOf(), dir, workspace: workspaceId });
        if (linked == null || linked.error) {
            this.madeWorkspace ??= choice.kind === "new" ? { dir, id: workspaceId } : null;
            globalStore.set(this.failureAtom, "link");
            return false;
        }
        BrainstormModel.getInstance().apply(linked.state);
        this.madeWorkspace = null;
        void this.refreshWorkspaces();
        return true;
    }

    // Try again on the card before the click: wavesrv's state is read again (a click it made but did not answer shows as
    // done), then the preview.
    async recheck(): Promise<void> {
        await BrainstormModel.getInstance().refresh();
        await this.refreshPreview();
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
