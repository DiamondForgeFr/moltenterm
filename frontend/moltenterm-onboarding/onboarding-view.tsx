// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first-run panel (FR-ONB-001, DS-ONB-001): a block that fills the first tab on a fresh install, or docks on the
// left of the tab when Getting started opens it again; it resizes like any pane and stays in place across a restart.
// Its page is the pour (FR-ONB-007, DS-ONB-007), full frame without a pane header; the record of the run lives in the
// client meta, written by wavesrv.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { atoms, getApi, replaceBlock } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { WorkspaceService } from "@/app/store/services";
import { getActiveTabModel } from "@/app/store/tab-model";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { I18nModel, t, useT } from "../moltenterm-shell/i18n/i18n";
import { serverErrorText } from "../moltenterm-shell/i18n/server-text";
import {
    chooseMoltentermPath,
    linkWorkspaceProject,
    readProjectFacts,
    setWorkspaceFolder,
} from "../moltenterm-shell/workspace-project-store";
import { canMorph, ChosenAgentKey, OnboardingAgents } from "./onboarding-agent-model";
import {
    currentOnboardingState,
    ensureMorphDir,
    listOnboardingAgents,
    onboardingUpdate,
    OnboardingUpdate,
} from "./onboarding-client";
import { OnboardingPour } from "./onboarding-pour";
import { keptAgent } from "./onboarding-pour-agents";
import { PourRecord, PourStart } from "./onboarding-pour-model";
import { projectColour, ProjectFolderKey } from "./onboarding-project-model";
import { MoltentermOnboardingView } from "./onboarding-state";

export { MoltentermOnboardingView };

// The palette's agent start, loaded on use: palette-actions opens Getting started, so a static import would loop back
// into this view.
async function typeCommand(blockId: string, command: string): Promise<boolean> {
    const { typeCommandWhenReady } = await import("../moltenterm-shell/palette/palette-actions");
    return typeCommandWhenReady(blockId, command);
}

export class OnboardingViewModel implements ViewModel {
    viewType = MoltentermOnboardingView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("compass");
    viewName = atom((get) => {
        get(I18nModel.getInstance().localeAtom);
        return t("onboarding.viewName");
    });
    noPadding = atom(true);
    // The pour is full frame (FR-SHELL-110, FR-ONB-007 AC-1): no pane header above it.
    noHeader = atom(true);
    busyAtom = atom(false) as PrimitiveAtom<boolean>;
    errorAtom = atom(null) as PrimitiveAtom<string>;
    agentsAtom = atom(null) as PrimitiveAtom<OnboardingAgents>;
    agentsErrorAtom = atom(null) as PrimitiveAtom<string>;
    checkingAtom = atom(false) as PrimitiveAtom<boolean>;

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return FirstRunPanel;
    }

    // One action at a time; a failure stays on the panel until the next action.
    async run(fn: () => Promise<void>): Promise<void> {
        if (globalStore.get(this.busyAtom)) {
            return;
        }
        globalStore.set(this.busyAtom, true);
        globalStore.set(this.errorAtom, null);
        try {
            await fn();
        } catch (e) {
            globalStore.set(this.errorAtom, serverErrorText(e));
        } finally {
            globalStore.set(this.busyAtom, false);
        }
    }

    update(update: OnboardingUpdate): Promise<unknown> {
        return onboardingUpdate(update);
    }

    // Scene 2's detection (FR-ONB-002), read again by Check again; a failure says so in the scene.
    async loadAgents(): Promise<void> {
        if (globalStore.get(this.checkingAtom)) {
            return;
        }
        globalStore.set(this.checkingAtom, true);
        globalStore.set(this.agentsErrorAtom, null);
        try {
            globalStore.set(this.agentsAtom, await listOnboardingAgents());
        } catch (e) {
            globalStore.set(
                this.agentsErrorAtom,
                t("onboarding.pour.agents.listFailed", { error: serverErrorText(e) })
            );
        } finally {
            globalStore.set(this.checkingAtom, false);
        }
    }

    // What moving on records (FR-ONB-007 AC-9): the welcome as before (Wave's terms, the welcome time), then the agent
    // step with the agent kept for /morph, or skipped when none is found. Moving on never waits for wavesrv.
    record(record: PourRecord) {
        fireAndForget(async () => {
            try {
                if (record === "welcome") {
                    await this.update({ kind: "welcome" });
                    return;
                }
                if (record !== "agents") {
                    return;
                }
                const agent = keptAgent(globalStore.get(this.agentsAtom));
                if (agent == null) {
                    await this.update({ kind: "step", step: "agent", status: "skipped" });
                    return;
                }
                await this.update({ kind: "data", step: "agent", data: { [ChosenAgentKey]: agent.id } });
                await this.update({ kind: "step", step: "agent", status: "done" });
            } catch (e) {
                globalStore.set(this.errorAtom, serverErrorText(e));
            }
        });
    }

    // Ending the run takes the panel away; Getting started brings it back. Closing the last pane of a tab closes the
    // tab, and the window with its last tab: a panel left alone in its tab gives way to a terminal instead.
    async closePanel(): Promise<void> {
        const tabAtom = getActiveTabModel()?.tabAtom;
        const blockCount = tabAtom == null ? 0 : (globalStore.get(tabAtom)?.blockids?.length ?? 0);
        if (blockCount === 1) {
            await replaceBlock(this.blockId, { meta: { view: "term", controller: "shell" } }, true);
            return;
        }
        uxCloseBlock(this.blockId);
    }

    // The run ends; a fresh install's starter workspace gets the template's views as it does (FR-SHELL-110), and
    // the first of them shows when asked. Asking wavesrv for them again only finds them.
    async finishRun(openView: boolean): Promise<void> {
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        const starter = !!workspaceId && currentOnboardingState().starterws === workspaceId;
        await this.update({ kind: "finish" });
        const tabId = openView && starter ? await WorkspaceService.AddWorkspaceViews(workspaceId) : "";
        await this.closePanel();
        if (tabId) {
            getApi().setActiveTab(tabId);
        }
    }

    // Skip: the run ends by leave, as the welcome's Skip did; Getting started stays in the Help menu.
    leave(): Promise<void> {
        return this.run(async () => {
            await this.update({ kind: "leave" });
            await this.closePanel();
        });
    }

    start(start: PourStart): Promise<void> {
        switch (start) {
            case "project":
                return this.openProject();
            case "morph":
                return this.tryMorph();
        }
        return this.run(() => this.finishRun(false));
    }

    // Open my project (AC-8): the folder becomes the workspace's, with the project's name and colour, and its project
    // (FR-ONB-004; its repository's root when it is in one); the run ends and the starter workspace's first view shows.
    // Cancelling the folder choice leaves the pour where it is.
    openProject(): Promise<void> {
        return this.run(async () => {
            const ws = globalStore.get(atoms.workspace);
            if (ws == null) {
                return;
            }
            const path = await chooseMoltentermPath({ kind: "folder", title: t("onboarding.pour.start.folderTitle") });
            if (!path) {
                return;
            }
            await setWorkspaceFolder(ws.oid, path);
            // Linked like New workspace links its folder (#1642): a folder without git is the project too, else the
            // default views open their file panel on the home folder.
            const dir = await linkWorkspaceProject(ws, path);
            const { name } = await readProjectFacts(dir);
            await WorkspaceService.UpdateWorkspace(ws.oid, name, ws.icon ?? "", projectColour(name), !ws.icon);
            await this.update({ kind: "data", step: "project", data: { [ProjectFolderKey]: path } });
            await this.update({ kind: "step", step: "project", status: "done" });
            await this.finishRun(true);
        });
    }

    // Try /morph (AC-8): the agent kept opens in the first morph's scratch folder (FR-ONB-003), in place of the panel;
    // the pour showed the request to paste before. Without an agent the run ends on the starter workspace's first
    // view, as the pour said.
    tryMorph(): Promise<void> {
        return this.run(async () => {
            const agent = keptAgent(globalStore.get(this.agentsAtom));
            if (agent == null || !canMorph(agent) || !agent.executable) {
                await this.finishRun(true);
                return;
            }
            const dir = await ensureMorphDir();
            await this.update({ kind: "finish" });
            const blockId = await replaceBlock(
                this.blockId,
                { meta: { view: "term", controller: "shell", "cmd:cwd": dir } },
                true
            );
            await typeCommand(blockId, agent.executable);
        });
    }
}

function PourFailed({ error }: { error?: Error }) {
    const t = useT();
    return (
        <p className="p-6 text-13 text-danger">
            {t("onboarding.stepFailed", { error: error?.message ?? t("onboarding.unknownError") })}
        </p>
    );
}

export function FirstRunPanel({ model }: ViewComponentProps<OnboardingViewModel>) {
    const busy = useAtomValue(model.busyAtom);
    const error = useAtomValue(model.errorAtom);
    const agents = useAtomValue(model.agentsAtom);
    const agentsError = useAtomValue(model.agentsErrorAtom);
    const checking = useAtomValue(model.checkingAtom);
    const reduced = useAtomValue(atoms.prefersReducedMotionAtom);

    // Reading the login shell's PATH can take seconds on the first call: the detection starts with the first scene.
    useEffect(() => {
        fireAndForget(() => model.loadAgents());
    }, [model]);

    return (
        <div className="h-full w-full overflow-hidden font-[family-name:var(--mt-ui-font)]">
            <ErrorBoundary fallback={<PourFailed />}>
                <OnboardingPour
                    reduced={!!reduced}
                    busy={busy}
                    error={error}
                    agents={agents}
                    agentsError={agentsError}
                    checking={checking}
                    onRecord={(record) => model.record(record)}
                    onCheckAgain={() => fireAndForget(() => model.loadAgents())}
                    onSkip={() => fireAndForget(() => model.leave())}
                    onStart={(start) => fireAndForget(() => model.start(start))}
                />
            </ErrorBoundary>
        </div>
    );
}
