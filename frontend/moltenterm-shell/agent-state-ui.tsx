// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the agent states show (FR-SHELL-011): the pane header (its title, pill and working segment:
// header/panel-header.tsx), the tab and the workspace icon of the rail (a dot with the most urgent state).

import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { cn, NullAtom } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { AgentStateDotClasses, AgentStateInfo, agentStateTitle } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";

export function AgentStateDot({ info, className }: { info: AgentStateInfo; className?: string }) {
    if (info == null) {
        return null;
    }
    return (
        <span
            className={cn(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                AgentStateDotClasses[info.state] ?? AgentStateDotClasses.idle,
                info.state === "working" && "animate-pulse",
                className
            )}
            role="img"
            aria-label={agentStateTitle(info)}
            title={agentStateTitle(info)}
        />
    );
}

// Without a block (a preview, another view) the store is not even started.
export function useBlockAgentState(blockId: string): AgentStateInfo {
    return useAtomValue(
        blockId == null ? (NullAtom as Atom<AgentStateInfo>) : AgentStates.getInstance().blockAtom(blockId)
    );
}

export function AgentTabDot({ tabId }: { tabId: string }) {
    const stateAtom = useMemo(() => {
        const tabAtom = getWaveObjectAtom<Tab>(makeORef("tab", tabId));
        return AgentStates.getInstance().tabAtom(atom((get) => get(tabAtom)?.blockids ?? []));
    }, [tabId]);
    const info = useAtomValue(stateAtom);
    return <AgentStateDot info={info} className="mr-1" />;
}

export function AgentRailDot({ workspaceId }: { workspaceId: string }) {
    const info = useAtomValue(AgentStates.getInstance().workspaceAtom(workspaceId));
    if (info == null) {
        return null;
    }
    return (
        <AgentStateDot
            info={info}
            className="molten-rail-agent-dot absolute right-1 bottom-1 ring-2 ring-[var(--color-background)]"
        />
    );
}
