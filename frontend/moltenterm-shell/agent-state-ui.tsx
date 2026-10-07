// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the agent states show (FR-SHELL-011): the pane header (agent, project, branch), the tab and the workspace
// icon of the rail (a dot with the most urgent state).

import { atoms } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget, NullAtom } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { AgentHookOfferChip } from "./agent-hooks-ui";
import { agentHeaderParts, AgentStateDotClasses, AgentStateInfo, agentStateTitle } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { sessionTooltipLine } from "./companion/companion-model";
import { toggleCompanion } from "./companion/companion-open";
import { CompanionSessions } from "./companion/companion-session-store";
import { usePaneStatus } from "./pane-status";
import { blockFolder, makePaneView } from "./status-bar-model";

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

function companionShortcutLabel(): string {
    return isMacOS() ? "⌘⇧J" : "Alt+Shift+J";
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

// The header of a terminal whose agent is known: its state, its name, the project and the branch of the pane's
// folder (the status bar's probe, DS-SHELL-010). Remote terminals have no local folder: the agent alone.
export function AgentHeaderLabel({ blockId, localName }: { blockId: string; localName?: string }) {
    const info = useBlockAgentState(blockId);
    const block = useAtomValue(getWaveObjectAtom<Block>(makeORef("block", blockId)));
    const ws = useAtomValue(atoms.workspace);
    const meta = block?.meta;
    const folder =
        info == null
            ? ""
            : blockFolder({ view: meta?.view, connection: meta?.connection, "cmd:cwd": meta?.["cmd:cwd"] });
    const paneState = usePaneStatus(folder, folder ? blockId : null);
    const companionSession = useAtomValue(CompanionSessions.getInstance().sessionAtom(blockId));
    if (info == null) {
        return null;
    }
    const pane = folder ? makePaneView(folder, paneState, ws) : null;
    const parts = agentHeaderParts(info, pane?.projectName, pane?.branch);
    // The session the open companion shows, so the terminal and its companion match at a glance (DS-SHELL-060).
    const sessionLine = sessionTooltipLine(companionSession, Date.now());
    const title = [agentStateTitle(info), sessionLine, folder, localName ? `on ${localName}` : ""]
        .filter((s) => !!s)
        .join("\n");
    // The label opens the agent companion next to the pane (FR-SHELL-018); the hook setup offer follows it (#221).
    return (
        <>
            <button
                type="button"
                className="flex min-w-0 shrink cursor-pointer items-center gap-1.5 rounded pl-1 pr-1 text-[12px] hover:bg-hover"
                title={`${title}\nClick for the agent companion (${companionShortcutLabel()})`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    fireAndForget(() => toggleCompanion(blockId));
                }}
                data-testid="agent-header-label"
            >
                <AgentStateDot info={info} />
                {parts.map((part, idx) => (
                    <span
                        key={idx}
                        className={cn(
                            "truncate",
                            idx === 0 ? "font-medium text-primary" : "text-secondary",
                            idx > 0 && "before:mr-1.5 before:text-muted before:content-['·']"
                        )}
                    >
                        {part}
                    </span>
                ))}
            </button>
            <AgentHookOfferChip blockId={blockId} />
        </>
    );
}
