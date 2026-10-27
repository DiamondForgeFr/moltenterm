// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace sidebar's state (FR-SHELL-079): its width and whether it is hidden live in the window's meta, so every
// tab view of the window draws the same sidebar and a relaunch keeps them; the peek (the sidebar shown over the content
// from the left edge) and a width being dragged stay in this view.

import { atoms, getSettingsKeyAtom, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { selectAtom } from "jotai/utils";
import { ProjectTabMetaKey } from "../project/project-model";
import { CreateDraft, makeCreateDraft } from "./sidebar-create-model";
import {
    clampSidebarWidth,
    readSidebarHidden,
    readSidebarWidth,
    sameTabSplit,
    SidebarDefaultWidth,
    sidebarEnabled,
    SidebarHiddenMetaKey,
    SidebarSettingKey,
    SidebarTabSplit,
    SidebarWidthMetaKey,
    splitSidebarTabs,
} from "./sidebar-model";
import { GlobalPinMetaKey, PinMetaKey } from "./view-pins-model";
import { ViewPins } from "./view-pins-store";
import type { ProjectDraft, WorkspaceProjectEntry } from "./workspace-projects";

// The page belongs to the workspace it was opened in: switching workspaces leaves it.
export type ProjectPage = { id?: string; workspaceId: string; draft: ProjectDraft };

// The tiles: the Project tab (#410) and the views pinned in the workspace (FR-SHELL-080).
const PinnedTabMetaKeys = [ProjectTabMetaKey, PinMetaKey];

export class SidebarModel {
    private static instance: SidebarModel = null;

    // A width being dragged, drawn at once and written to the window when the drag ends.
    draggingWidthAtom = jotai.atom(null) as jotai.PrimitiveAtom<number>;
    // Set until the window's meta echoes the change, so a toggle shows at once.
    pendingHiddenAtom = jotai.atom(null) as jotai.PrimitiveAtom<boolean>;
    peekAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    // The add-a-project page while it is open (FR-SHELL-087); with an id it edits that project.
    projectPageAtom = jotai.atom(null) as jotai.PrimitiveAtom<ProjectPage>;
    // The new-workspace page while it is open (FR-SHELL-082): the bottom row draws its pending dot from it.
    createDraftAtom = jotai.atom(null) as jotai.PrimitiveAtom<CreateDraft>;
    // Bumped to open the library from a pull past the first workspace.
    libraryRequestAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;

    enabledAtom!: jotai.Atom<boolean>;
    windowMetaAtom!: jotai.Atom<Record<string, any>>;
    widthAtom!: jotai.Atom<number>;
    hiddenAtom!: jotai.Atom<boolean>;
    // The workspace's tabs as tiles and temporary views; a new value only when the lists change.
    tabSplitAtom!: jotai.Atom<SidebarTabSplit>;

    private constructor() {
        this.tabSplitAtom = selectAtom(
            jotai.atom((get) =>
                splitSidebarTabs(
                    get(atoms.workspace),
                    (id) => get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", id))),
                    PinnedTabMetaKeys,
                    new Set(get(ViewPins.getInstance().globalPinsAtom).map((p) => p.id)),
                    GlobalPinMetaKey
                )
            ),
            (split) => split,
            sameTabSplit
        );
        this.enabledAtom = jotai.atom((get) =>
            sidebarEnabled(get(getSettingsKeyAtom(SidebarSettingKey as keyof SettingsType)) as boolean)
        );
        this.windowMetaAtom = jotai.atom((get) => {
            const windowId = get(atoms.uiContext)?.windowid;
            if (!windowId) {
                return null;
            }
            return WOS.getObjectValue<WaveWindow>(WOS.makeORef("window", windowId), get)?.meta ?? null;
        });
        this.widthAtom = jotai.atom((get) => get(this.draggingWidthAtom) ?? readSidebarWidth(get(this.windowMetaAtom)));
        this.hiddenAtom = jotai.atom(
            (get) => get(this.pendingHiddenAtom) ?? readSidebarHidden(get(this.windowMetaAtom))
        );
    }

    static getInstance(): SidebarModel {
        if (SidebarModel.instance == null) {
            SidebarModel.instance = new SidebarModel();
        }
        return SidebarModel.instance;
    }

    isEnabled(): boolean {
        return globalStore.get(this.enabledAtom);
    }

    isHidden(): boolean {
        return globalStore.get(this.hiddenAtom);
    }

    private writeWindowMeta(meta: Record<string, any>): Promise<void> {
        const windowId = globalStore.get(atoms.uiContext)?.windowid;
        if (!windowId) {
            return Promise.resolve();
        }
        return RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("window", windowId), meta: meta as MetaType });
    }

    dragWidth(width: number) {
        globalStore.set(this.draggingWidthAtom, clampSidebarWidth(width));
    }

    commitWidth(width: number) {
        const value = clampSidebarWidth(width);
        globalStore.set(this.draggingWidthAtom, value);
        fireAndForget(async () => {
            try {
                await this.writeWindowMeta({ [SidebarWidthMetaKey]: value });
            } finally {
                globalStore.set(this.draggingWidthAtom, null);
            }
        });
    }

    resetWidth() {
        this.commitWidth(SidebarDefaultWidth);
    }

    setHidden(hidden: boolean) {
        globalStore.set(this.pendingHiddenAtom, hidden);
        globalStore.set(this.peekAtom, false);
        fireAndForget(async () => {
            try {
                await this.writeWindowMeta({ [SidebarHiddenMetaKey]: hidden });
            } finally {
                globalStore.set(this.pendingHiddenAtom, null);
            }
        });
    }

    toggleHidden() {
        this.setHidden(!this.isHidden());
    }

    setPeek(peek: boolean) {
        globalStore.set(this.peekAtom, peek);
    }

    openProjectPage(project?: WorkspaceProjectEntry) {
        const draft: ProjectDraft =
            project == null
                ? { type: "", dir: "", branch: "" }
                : { type: project.type, dir: project.dir, branch: project.branch };
        globalStore.set(this.projectPageAtom, {
            id: project?.id,
            workspaceId: globalStore.get(atoms.workspace)?.oid,
            draft,
        });
    }

    updateProjectDraft(change: Partial<ProjectDraft>) {
        const page = globalStore.get(this.projectPageAtom);
        if (page == null) {
            return;
        }
        globalStore.set(this.projectPageAtom, { ...page, draft: { ...page.draft, ...change } });
    }

    closeProjectPage() {
        globalStore.set(this.projectPageAtom, null);
    }

    startCreate(colour: string) {
        if (globalStore.get(this.createDraftAtom) != null) {
            return;
        }
        globalStore.set(this.createDraftAtom, makeCreateDraft(colour));
    }

    updateDraft(change: Partial<CreateDraft>) {
        const draft = globalStore.get(this.createDraftAtom);
        if (draft == null) {
            return;
        }
        globalStore.set(this.createDraftAtom, { ...draft, ...change });
    }

    cancelCreate() {
        globalStore.set(this.createDraftAtom, null);
    }

    openLibrary() {
        globalStore.set(this.libraryRequestAtom, globalStore.get(this.libraryRequestAtom) + 1);
    }
}
