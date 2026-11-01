// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first run's calls to wavesrv (pkg/molten/onboarding/route.go), the record's only writer.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    OnboardingAgent,
    OnboardingAgentInstallCommand,
    OnboardingAgents,
    OnboardingAgentsCommand,
    OnboardingAgentSignInCommand,
} from "./onboarding-agent-model";
import {
    CliInstallCancelCommand,
    CliInstallCommand,
    CliInstallInputCommand,
    CliInstallStatus,
    CliInstallStatusCommand,
    CliUninstallCommand,
} from "./onboarding-install-model";
import { OnboardingMorphDirCommand } from "./onboarding-morph-model";
import { OnboardingProjectsCommand, ProjectCandidate } from "./onboarding-project-model";
import {
    FirstRunPage,
    FirstRunStepId,
    OnboardingMetaKey,
    OnboardingPageMetaKey,
    OnboardingPanelCommand,
    OnboardingRoute,
    OnboardingState,
    OnboardingUpdateCommand,
    readOnboardingState,
} from "./onboarding-state";

const OnboardingCallTimeoutMs = 10000;
// wavesrv gives the login shell up to 8 s to print its PATH
const OnboardingRefreshTimeoutMs = 20000;

export type OnboardingUpdate =
    | { kind: "welcome" }
    | { kind: "step"; step: FirstRunStepId; status: "done" | "skipped" | "todo" }
    | { kind: "data"; step: FirstRunStepId; data: Record<string, any> }
    | { kind: "leave" }
    | { kind: "finish" };

export type OnboardingPanelLocation = { tabid?: string; blockid?: string };

export async function onboardingUpdate(update: OnboardingUpdate): Promise<OnboardingState> {
    const state = await TabRpcClient.wshRpcCall(OnboardingUpdateCommand, update, {
        route: OnboardingRoute,
        timeout: OnboardingCallTimeoutMs,
    });
    return readOnboardingState({ [OnboardingMetaKey]: state } as MetaType);
}

// The workspace's first-run panel, active tab first.
export async function findOnboardingPanel(workspaceId: string): Promise<OnboardingPanelLocation> {
    if (!workspaceId) {
        return {};
    }
    const rtn = await TabRpcClient.wshRpcCall(
        OnboardingPanelCommand,
        { workspaceid: workspaceId },
        { route: OnboardingRoute, timeout: OnboardingCallTimeoutMs }
    );
    return rtn ?? {};
}

// Reading the login shell's PATH can take seconds; wavesrv reads it once, and again with refresh (Check again, the
// check after an install), so an agent installed after launch is found (#1667).
export async function listOnboardingAgents(refresh?: boolean): Promise<OnboardingAgents> {
    const rtn = await TabRpcClient.wshRpcCall(OnboardingAgentsCommand, refresh ? { refresh: true } : {}, {
        route: OnboardingRoute,
        timeout: refresh ? OnboardingRefreshTimeoutMs : OnboardingCallTimeoutMs,
    });
    return rtn ?? { agents: [], version: "" };
}

function cliInstallCall(
    command: string,
    data: { id: string; text?: string; removeconfig?: boolean }
): Promise<CliInstallStatus> {
    return TabRpcClient.wshRpcCall(command, data, { route: OnboardingRoute, timeout: OnboardingCallTimeoutMs });
}

// Install runs the agent's catalog command in wavesrv: only the id crosses (FR-ONB-007 AC-5).
export function startCliInstall(id: string): Promise<CliInstallStatus> {
    return cliInstallCall(CliInstallCommand, { id });
}

// Uninstall (#1699): the id and the tick for the settings folders cross, never a command; wavesrv finds the method
// again from the copy it sees.
export function startCliUninstall(id: string, removeConfig: boolean): Promise<CliInstallStatus> {
    return cliInstallCall(CliUninstallCommand, removeConfig ? { id, removeconfig: true } : { id });
}

export function cliInstallStatus(id: string): Promise<CliInstallStatus> {
    return cliInstallCall(CliInstallStatusCommand, { id });
}

export function answerCliInstall(id: string, text: string): Promise<CliInstallStatus> {
    return cliInstallCall(CliInstallInputCommand, { id, text });
}

export function cancelCliInstall(id: string): Promise<CliInstallStatus> {
    return cliInstallCall(CliInstallCancelCommand, { id });
}

// Sign in (#1723): the id and the line printed above the command cross, never a command; wavesrv answers the
// terminal's meta, built from its catalog.
export async function agentSignInMeta(id: string, note: string): Promise<MetaType> {
    const rtn = await TabRpcClient.wshRpcCall(
        OnboardingAgentSignInCommand,
        { id, note },
        { route: OnboardingRoute, timeout: OnboardingRefreshTimeoutMs }
    );
    return rtn?.meta;
}

export async function installDeclinedAgent(id: string): Promise<OnboardingAgent> {
    return TabRpcClient.wshRpcCall(
        OnboardingAgentInstallCommand,
        { id },
        {
            route: OnboardingRoute,
            timeout: OnboardingCallTimeoutMs,
        }
    );
}

// Creates the first morph's scratch folder and returns it.
export async function ensureMorphDir(): Promise<string> {
    const rtn = await TabRpcClient.wshRpcCall(
        OnboardingMorphDirCommand,
        {},
        { route: OnboardingRoute, timeout: OnboardingCallTimeoutMs }
    );
    return rtn?.path;
}

// The git repositories under the home folder, scanned by wavesrv once per run.
export async function scanProjectCandidates(): Promise<ProjectCandidate[]> {
    const rtn = await TabRpcClient.wshRpcCall(
        OnboardingProjectsCommand,
        {},
        { route: OnboardingRoute, timeout: OnboardingCallTimeoutMs }
    );
    return rtn?.projects ?? [];
}

export function clientMeta(): MetaType {
    const clientAtom = ClientModel.getInstance().clientAtom;
    return clientAtom == null ? null : globalStore.get(clientAtom)?.meta;
}

export function currentOnboardingState(): OnboardingState {
    return readOnboardingState(clientMeta());
}

// The panel's page lives in its block meta, so it survives a restart and a window can send another tab's panel to a
// page.
export async function setPanelPage(blockId: string, page: FirstRunPage): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, {
        oref: makeORef("block", blockId),
        meta: { [OnboardingPageMetaKey]: page } as MetaType,
    });
}
