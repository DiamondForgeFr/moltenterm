// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Typing the morph call into the workspace's agent (#1653, #1672), for the Library's "Missing a tool?" card and the
// ⌘T launcher's empty result. The rules are in morph-call-model.ts.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";
import type { AgentStateInfo } from "../agent-state-model";
import { MoltentermNotifications } from "../notifications-store";
import { morphCallText } from "./morph-call-model";

// Goes to the agent's terminal, focuses it and types the call and the request, without Enter: the developer completes
// the request and sends it.
export async function typeMorphCall(agent: AgentStateInfo, request?: string): Promise<void> {
    await MoltentermNotifications.getInstance().goTo({
        workspaceid: agent.workspaceid,
        tabid: agent.tabid,
        blockid: agent.blockid,
    });
    await RpcApi.ControllerInputCommand(TabRpcClient, {
        blockid: agent.blockid,
        inputdata64: stringToBase64(morphCallText(agent.agent, request)),
    });
}
