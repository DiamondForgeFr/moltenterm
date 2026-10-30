// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Release menu's setup actions open the pipeline setup's tab (FR-MC-038, #1150), as a pull request card opens its
// Review tab: wavesrv returns the project's tab, made the first time, and the window shows it. An existing tab is only
// focused, so the step and the answers on it stay as they are.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { showTabFromHere } from "../opener-tab";
import { pathBaseName } from "../workspace-project";
import { MissionRouteId } from "./mission-client";
import { PipelineTabCommand } from "./pipeline-tab-model";
import type { StepperStep } from "./release-setup-stepper";

const OpenTimeoutMs = 15000;

export type PipelineTabDeps = {
    workspaceId: () => string;
    call: (data: Record<string, unknown>) => Promise<{ tabid: string; created?: boolean }>;
    show: (tabId: string) => void;
};

const DefaultDeps: PipelineTabDeps = {
    workspaceId: () => globalStore.get(atoms.workspace)?.oid,
    call: (data) =>
        TabRpcClient.wshRpcCall(PipelineTabCommand, data, { route: MissionRouteId, timeout: OpenTimeoutMs }),
    show: showTabFromHere,
};

// Returns the tab's id, "" when there is no workspace to open it in.
export async function openPipelineSetupTab(
    dir: string,
    projectName: string,
    openAt?: StepperStep,
    deps: PipelineTabDeps = DefaultDeps
): Promise<string> {
    const workspaceid = deps.workspaceId();
    if (!dir || !workspaceid) {
        return "";
    }
    const project = projectName || pathBaseName(dir);
    const { tabid } = await deps.call({
        workspaceid,
        dir,
        project,
        tabname: t("pipelineTab.name", { project }),
        openat: openAt ?? "",
    });
    deps.show(tabid);
    return tabid;
}

// The setup actions open the setup's own tab (#1150), focused when it is already open; a failure is said in place.
export function openSetupTab(dir: string, projectName: string, openAt: StepperStep, onError: (text: string) => void) {
    fireAndForget(async () => {
        try {
            await openPipelineSetupTab(dir, projectName, openAt);
        } catch (e) {
            onError(serverErrorText(e));
        }
    });
}
