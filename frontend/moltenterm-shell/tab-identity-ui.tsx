// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pieces of a top tab that MoltenTerm draws (FR-SHELL-056, DS-SHELL-098): the 14 px icon, the name shown in place
// of Wave's generic T<n>, and the agent mark, whose shape tells the state without its colour (NFR-SHELL-026): a
// pulsing ring while working, a solid amber disc while waiting, a red diamond on error, a small green disc when done.

import { atoms, getApi } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { cn, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { AgentStateInfo, agentStatesOfBlocks, agentStateTitle } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { ProjectTabMetaKey } from "./project/project-model";
import { agentGlyph, panelIcon, PanelMeta, tabDisplayName } from "./tab-identity";

let homeDir: string = null;

function getHomeDir(): string {
    if (homeDir == null) {
        try {
            homeDir = getApi()?.getHomeDir?.() ?? "";
        } catch {
            homeDir = "";
        }
    }
    return homeDir;
}

export type TabIdentity = {
    name: string;
    icon: string;
    pinned: boolean;
    agent: AgentStateInfo;
};

// The tab's first panel decides the icon and the generic name; any agent of the tab (idle included) gives its glyph,
// the most urgent one the mark.
export function useTabIdentity(tabId: string, tabName: string): TabIdentity {
    const identityAtom = useMemo(() => {
        const tabAtom = getWaveObjectAtom<Tab>(makeORef("tab", tabId));
        return atom((get) => {
            const tab = get(tabAtom);
            const blockIds = tab?.blockids ?? [];
            const first = blockIds.length > 0 ? get(getWaveObjectAtom<Block>(makeORef("block", blockIds[0]))) : null;
            const agents = agentStatesOfBlocks(get(AgentStates.getInstance().dataAtom), blockIds);
            return {
                meta: (first?.meta ?? null) as PanelMeta,
                pinned: !!(tab?.meta as Record<string, unknown>)?.[ProjectTabMetaKey],
                agentId: agents[0]?.agent ?? "",
            };
        });
    }, [tabId]);
    const urgentAtom = useMemo(() => {
        const tabAtom = getWaveObjectAtom<Tab>(makeORef("tab", tabId));
        return AgentStates.getInstance().tabAtom(atom((get) => get(tabAtom)?.blockids ?? []));
    }, [tabId]);
    const facts = useAtomValue(identityAtom);
    const urgent = useAtomValue(urgentAtom);
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const presets = fullConfig?.presets as Record<string, Record<string, unknown>>;
    const icon = facts.agentId ? agentGlyph(facts.agentId, presets) : panelIcon(facts.meta);
    return {
        name: tabDisplayName(tabName, facts.meta, getHomeDir()),
        icon,
        pinned: facts.pinned,
        agent: urgent,
    };
}

export function TabIcon({ icon, title }: { icon: string; title?: string }) {
    return (
        <i
            className={cn(makeIconClass(icon, true, { defaultIcon: "square" }), "molten-tab-icon text-icon-14")}
            aria-hidden={title ? undefined : true}
            aria-label={title}
            role={title ? "img" : undefined}
        />
    );
}

export function agentMarkTitle(info: AgentStateInfo): string {
    if (info == null) {
        return "";
    }
    const title = agentStateTitle(info);
    return info.state === "error" ? `! ${title}` : title;
}

export function TabAgentMark({ info }: { info: AgentStateInfo }) {
    if (info == null) {
        return null;
    }
    const title = agentMarkTitle(info);
    return (
        <span
            className="molten-tab-dot"
            data-state={info.state}
            role="img"
            aria-label={title}
            title={title}
            data-testid="tab-agent-mark"
        />
    );
}
