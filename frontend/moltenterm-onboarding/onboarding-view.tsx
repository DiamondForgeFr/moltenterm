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
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { I18nModel, t, useLocale, useT } from "../moltenterm-shell/i18n/i18n";
import { serverErrorText } from "../moltenterm-shell/i18n/server-text";
import { missionGitInit } from "../moltenterm-shell/mission/mission-client";
import { ViewPins } from "../moltenterm-shell/sidebar/view-pins-store";
import { workspaceShownName } from "../moltenterm-shell/workspace-default-name";
import { readRecentFolders } from "../moltenterm-shell/workspace-project";
import {
    chooseMoltentermPath,
    linkWorkspaceProject,
    readProjectFacts,
    setWorkspaceFolder,
} from "../moltenterm-shell/workspace-project-store";
import { suggestionConfig } from "../moltenterm-shell/workspace-views/view-suggestions";
import { ChosenAgentKey, OnboardingAgents } from "./onboarding-agent-model";
import {
    answerCliInstall,
    cancelCliInstall,
    cliInstallStatus,
    listOnboardingAgents,
    onboardingUpdate,
    OnboardingUpdate,
    scanProjectCandidates,
    startCliInstall,
} from "./onboarding-client";
import {
    cleanFolderName,
    defaultProjectsFolder,
    FirstViewPlan,
    projectTarget,
    ProjectDraft,
    ProjectResult,
    shownPath,
} from "./onboarding-first-view-model";
import { CliInstallStatus, isRunning } from "./onboarding-install-model";
import { OnboardingPour } from "./onboarding-pour";
import { keptAgent } from "./onboarding-pour-agents";
import { PourRecord } from "./onboarding-pour-model";
import { ProjectCandidate, projectCandidates, projectColour, ProjectFolderKey } from "./onboarding-project-model";
import { MoltentermOnboardingView } from "./onboarding-state";

export { MoltentermOnboardingView };

const InstallPollMs = 400;
// The view step's data: the panels of the view made, and where it was pinned.
export const ViewPanelsKey = "panels";
export const ViewPlaceKey = "place";

function homeDir(): string {
    try {
        return getApi()?.getHomeDir?.() ?? "";
    } catch {
        return "";
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path } });
        return info != null && !info.notfound;
    } catch {
        return false;
    }
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
    installsAtom = atom({}) as PrimitiveAtom<Record<string, CliInstallStatus>>;
    candidatesAtom = atom([]) as PrimitiveAtom<ProjectCandidate[]>;
    scanningAtom = atom(false) as PrimitiveAtom<boolean>;
    // The project the scene set last: going back and on again without a change links nothing twice.
    lastProject: { path: string; result: ProjectResult } = null;

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

    // Scene 2's detection (FR-ONB-002), read again by Check again with the login PATH read again (refresh, #1667); a
    // failure says so in the scene.
    async loadAgents(refresh?: boolean): Promise<void> {
        if (globalStore.get(this.checkingAtom)) {
            return;
        }
        globalStore.set(this.checkingAtom, true);
        globalStore.set(this.agentsErrorAtom, null);
        try {
            globalStore.set(this.agentsAtom, await listOnboardingAgents(refresh));
        } catch (e) {
            globalStore.set(
                this.agentsErrorAtom,
                t("onboarding.pour.agents.listFailed", { error: serverErrorText(e) })
            );
        } finally {
            globalStore.set(this.checkingAtom, false);
        }
    }

    // The project scene's candidates (FR-ONB-004): the workspace's recent folders, then the repositories wavesrv
    // finds under the home folder, read only.
    async loadCandidates(): Promise<void> {
        globalStore.set(this.scanningAtom, true);
        const recent = readRecentFolders(globalStore.get(atoms.workspace));
        globalStore.set(this.candidatesAtom, projectCandidates(recent, []));
        try {
            globalStore.set(this.candidatesAtom, projectCandidates(recent, await scanProjectCandidates()));
        } catch (e) {
            console.log("first run: project scan failed", e);
        } finally {
            globalStore.set(this.scanningAtom, false);
        }
    }

    setInstall(status: CliInstallStatus) {
        globalStore.set(this.installsAtom, { ...globalStore.get(this.installsAtom), [status.id]: status });
    }

    // Install on a card (FR-ONB-007 AC-5): wavesrv runs the catalog's command for this id; the card follows it, then
    // MoltenTerm checks again by itself, the login PATH read again.
    async install(id: string): Promise<void> {
        if (isRunning(globalStore.get(this.installsAtom)[id])) {
            return;
        }
        try {
            this.setInstall(await startCliInstall(id));
        } catch (e) {
            this.setInstall({ id, state: "failed", error: serverErrorText(e) });
            return;
        }
        await this.followInstall(id);
    }

    async followInstall(id: string): Promise<void> {
        while (isRunning(globalStore.get(this.installsAtom)[id])) {
            await new Promise((resolve) => setTimeout(resolve, InstallPollMs));
            try {
                this.setInstall(await cliInstallStatus(id));
            } catch (e) {
                console.log("first run: install status failed", e);
            }
        }
        if (globalStore.get(this.installsAtom)[id]?.state === "canceled") {
            return;
        }
        while (globalStore.get(this.checkingAtom)) {
            await new Promise((resolve) => setTimeout(resolve, InstallPollMs));
        }
        await this.loadAgents(true);
    }

    async answerInstall(id: string, text: string): Promise<void> {
        try {
            this.setInstall(await answerCliInstall(id, text));
        } catch (e) {
            console.log("first run: install answer failed", e);
        }
    }

    async cancelInstall(id: string): Promise<void> {
        try {
            this.setInstall(await cancelCliInstall(id));
        } catch (e) {
            console.log("first run: install cancel failed", e);
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

    // The computer's own folder chooser, which offers its own New folder action; null when cancelled.
    async chooseFolder(purpose: "where" | "find", current: string): Promise<string> {
        const title = t(purpose === "where" ? "onboarding.pour.project.whereTitle" : "onboarding.pour.project.findTitle");
        try {
            return (await chooseMoltentermPath({ kind: "folder", title, defaultPath: current || homeDir() })) || null;
        } catch (e) {
            globalStore.set(this.errorAtom, serverErrorText(e));
            return null;
        }
    }

    // Leaving the project scene (FR-ONB-007 P-4): Create a project makes its folder (refused when the name is taken
    // there) and, when asked, its git repository (#1650, #1671: never inside another repository); Find links the
    // folder chosen. Either way the folder becomes the workspace's, with the project's name and colour, as Open my
    // project did (FR-ONB-004). null keeps the scene, the error saying why.
    async leaveProject(draft: ProjectDraft): Promise<ProjectResult> {
        if (globalStore.get(this.busyAtom)) {
            return null;
        }
        const path = projectTarget(draft);
        const ws = globalStore.get(atoms.workspace);
        if (!path || ws == null) {
            return null;
        }
        if (this.lastProject?.path === path) {
            return this.lastProject.result;
        }
        globalStore.set(this.busyAtom, true);
        globalStore.set(this.errorAtom, null);
        try {
            if (draft.mode === "new") {
                if (await pathExists(path)) {
                    throw new Error(
                        t("onboarding.pour.project.taken", {
                            name: cleanFolderName(draft.name),
                            where: shownPath(draft.location, homeDir()),
                        })
                    );
                }
                await RpcApi.FileMkdirCommand(TabRpcClient, { info: { path } });
                if (draft.git) {
                    await missionGitInit(path).catch((e) => console.log("first run: git init", e?.message ?? e));
                }
            }
            await setWorkspaceFolder(ws.oid, path);
            const dir = await linkWorkspaceProject(ws, path);
            const { name } = await readProjectFacts(dir);
            const colour = projectColour(name);
            await WorkspaceService.UpdateWorkspace(ws.oid, name, ws.icon ?? "", colour, !ws.icon);
            await this.update({ kind: "data", step: "project", data: { [ProjectFolderKey]: path } });
            await this.update({ kind: "step", step: "project", status: "done" });
            const result: ProjectResult = { name, path: shownPath(dir, homeDir()), colour };
            this.lastProject = { path, result };
            return result;
        } catch (e) {
            globalStore.set(this.errorAtom, serverErrorText(e));
            return null;
        } finally {
            globalStore.set(this.busyAtom, false);
        }
    }

    laterProject() {
        fireAndForget(async () => {
            try {
                await this.update({ kind: "step", step: "project", status: "skipped" });
            } catch (e) {
                console.log("first run: project skipped", e);
            }
        });
    }

    // Ending the run takes the panel away; Getting started brings it back. Closing the last pane of a tab closes the
    // tab, and the window with its last tab: a panel left alone in its tab gives way to a terminal instead, unless the
    // run made a view to show, which then takes its place.
    async closePanel(viewTabId?: string): Promise<void> {
        const tab = getActiveTabModel()?.tabAtom;
        const tabValue = tab == null ? null : globalStore.get(tab);
        const alone = (tabValue?.blockids?.length ?? 0) === 1;
        if (viewTabId) {
            getApi().setActiveTab(viewTabId);
            const ws = globalStore.get(atoms.workspace);
            if (alone && ws != null && tabValue != null) {
                await getApi().closeTab(ws.oid, tabValue.oid, false);
                return;
            }
        }
        if (alone) {
            await replaceBlock(this.blockId, { meta: { view: "term", controller: "shell" } }, true);
            return;
        }
        uxCloseBlock(this.blockId);
    }

    // Skip: the run ends by leave, as the welcome's Skip did; no view is made and Getting started stays in the Help
    // menu.
    leave(): Promise<void> {
        return this.run(async () => {
            await this.update({ kind: "leave" });
            await this.closePanel();
        });
    }

    // Enter the workshop (FR-ONB-009): the view the user built, made now in this workspace, pinned where they chose and
    // shown first; without one (Later on the view) the workspace shows its empty state. Nothing starts: the agent's
    // place waits for a click.
    start(plan: FirstViewPlan): Promise<void> {
        return this.run(async () => {
            let viewTabId: string = null;
            if (plan != null) {
                viewTabId = await ViewPins.getInstance().createView({
                    config: suggestionConfig(plan.panels, plan.agentId),
                    scope: plan.place,
                    name: plan.name,
                    nameKey: plan.nameKey,
                    background: true,
                });
                await this.update({
                    kind: "data",
                    step: "view",
                    data: { [ViewPanelsKey]: plan.panels, [ViewPlaceKey]: plan.place },
                });
            }
            await this.update({ kind: "step", step: "view", status: plan != null ? "done" : "skipped" });
            await this.update({ kind: "finish" });
            await this.closePanel(viewTabId);
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
    const installs = useAtomValue(model.installsAtom);
    const candidates = useAtomValue(model.candidatesAtom);
    const scanning = useAtomValue(model.scanningAtom);
    const reduced = useAtomValue(atoms.prefersReducedMotionAtom);
    const ws = useAtomValue(atoms.workspace);
    const locale = useLocale();
    const tr = useT();
    const home = homeDir();

    // Reading the login shell's PATH can take seconds on the first call: the detection starts with the first scene,
    // and the folder scan with it.
    useEffect(() => {
        fireAndForget(() => model.loadAgents());
        fireAndForget(() => model.loadCandidates());
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
                    home={home}
                    projectsFolder={defaultProjectsFolder(home, locale)}
                    candidates={candidates}
                    scanning={scanning}
                    workspaceName={workspaceShownName(ws?.name, tr)}
                    onRecord={(record) => model.record(record)}
                    installs={installs}
                    onCheckAgain={() => fireAndForget(() => model.loadAgents(true))}
                    onInstall={(id) => fireAndForget(() => model.install(id))}
                    onAnswerInstall={(id, text) => fireAndForget(() => model.answerInstall(id, text))}
                    onCancelInstall={(id) => fireAndForget(() => model.cancelInstall(id))}
                    onSkip={() => fireAndForget(() => model.leave())}
                    onLeaveProject={(draft) => model.leaveProject(draft)}
                    onLaterProject={() => model.laterProject()}
                    onChooseFolder={(purpose, current) => model.chooseFolder(purpose, current)}
                    onStart={(plan) => fireAndForget(() => model.start(plan))}
                />
            </ErrorBoundary>
        </div>
    );
}
