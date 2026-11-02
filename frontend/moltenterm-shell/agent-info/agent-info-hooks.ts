// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the sidebar's agent tree and the agent window read from the stores (FR-SHELL-084).

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { agentCallName, type AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { t } from "../i18n/i18n";
import { MoltentermNotifications } from "../notifications-store";
import { workspaceShownName } from "../workspace-default-name";
import { linkedAgents, nextSubagentExpiry, type LinkedAgent, type SubagentRow } from "./agent-info-model";
import { AgentInfoModel } from "./agent-info-store";

// must match HandedByMetaKey in pkg/molten/durablesession.go
const HandedByMetaKey = "molten:handedby";

// A little after the expiry, so the clock has certainly passed it when the list is read again.
const SubagentExpiryGraceMs = 50;

// The terminal that first handed each agent terminal work, from the blocks' meta.
const handedByAtom = atom((get) => {
    const data = get(AgentStates.getInstance().dataAtom);
    const rtn: Record<string, string> = {};
    for (const id of Object.keys(data.states)) {
        const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", id)));
        const parent = (block?.meta as Record<string, unknown>)?.[HandedByMetaKey];
        if (typeof parent === "string" && parent) {
            rtn[id] = parent;
        }
    }
    return rtn;
});

export type LinkedAgentRow = LinkedAgent & { workspaceId?: string; tabId?: string; info?: AgentStateInfo };

export function useLinkedAgents(blockId: string): LinkedAgentRow[] {
    const history = useAtomValue(AgentInfoModel.getInstance().historyAtom);
    const handedBy = useAtomValue(handedByAtom);
    const data = useAtomValue(AgentStates.getInstance().dataAtom);
    return useMemo(() => {
        const nameOf = (id: string) => {
            const info = data.states[id];
            return info ? agentCallName(info, "") : "";
        };
        return linkedAgents(blockId, history, handedBy, nameOf).map((row) => {
            const info = data.states[row.blockId];
            return {
                ...row,
                name: row.name || t("agentInfo.aTerminal"),
                info,
                workspaceId: info?.workspaceid,
                tabId: info?.tabid,
            };
        });
    }, [blockId, history, handedBy, data]);
}

export function useWorkspaceName(workspaceId: string): string {
    const workspace = useAtomValue(
        useMemo(
            () => (workspaceId ? WOS.getWaveObjectAtom<Workspace>(WOS.makeORef("workspace", workspaceId)) : atom(null)),
            [workspaceId]
        )
    ) as Workspace;
    return workspaceShownName(workspace?.name, t) || "";
}

// Opens an agent's terminal: its workspace, its tab, then its panel, as a notification does.
export function goToAgent(info: { workspaceid?: string; tabid?: string; blockid: string }): Promise<void> {
    if (info?.blockid == null) {
        return Promise.resolve();
    }
    return MoltentermNotifications.getInstance().goTo({
        workspaceid: info.workspaceid,
        tabid: info.tabid,
        blockid: info.blockid,
    });
}

export function agentInfoOf(blockId: string): AgentStateInfo {
    return globalStore.get(AgentStates.getInstance().blockAtom(blockId));
}

// The time to judge a sub-agent list by, which moves on by itself when a finished sub-agent is due to leave (#1542): the
// caller renders again then, and the sub-agent is gone. The timer is set once per expiry, never polled.
export function useSubagentNow(rows: SubagentRow[]): number {
    const [, setTick] = useState(0);
    const now = Date.now();
    const wait = nextSubagentExpiry(rows, now);
    const expiresAt = wait == null ? null : now + wait;
    useEffect(() => {
        if (expiresAt == null) {
            return;
        }
        const timer = setTimeout(
            () => setTick((n) => n + 1),
            Math.max(expiresAt - Date.now(), 0) + SubagentExpiryGraceMs
        );
        return () => clearTimeout(timer);
    }, [expiresAt]);
    return now;
}
