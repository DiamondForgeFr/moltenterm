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
} from "./onboarding-agent-model";
import { OnboardingMorphDirCommand } from "./onboarding-morph-model";
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

// Reading the login shell's PATH can take seconds on the first call; wavesrv reads it once.
export async function listOnboardingAgents(): Promise<OnboardingAgents> {
    const rtn = await TabRpcClient.wshRpcCall(
        OnboardingAgentsCommand,
        {},
        {
            route: OnboardingRoute,
            timeout: OnboardingCallTimeoutMs,
        }
    );
    return rtn ?? { agents: [], version: "" };
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
