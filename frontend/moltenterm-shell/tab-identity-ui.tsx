// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pieces of a top tab that MoltenTerm draws (FR-SHELL-056, DS-SHELL-098): the 14 px icon, the name shown in place
// of Wave's generic T<n>, and the agent mark, whose shape tells the state without its colour (NFR-SHELL-026): a
// pulsing ring while working, a solid amber disc while waiting, a red diamond on error, a small green disc when done.

import { getApi } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { cn, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { AgentStateInfo, agentStatesOfBlocks, agentStateTitle } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { TFunction, useT } from "./i18n/i18n";
import { ProjectTabMetaKey, ProjectTabName } from "./project/project-model";
import { ReviewDoneMeta, reviewDoneTabTitle } from "./review/review-done";
import { tabAgentName, tabAgentsByRun, tabAgentsTitle } from "./tab-agents";
import { AiIcon, panelIcon, PanelMeta, panelReviewDone, tabDisplayName } from "./tab-identity";
import { useWorkingBeat } from "./working-beat";
import { ViewNameKeyMetaKey, viewShownName } from "./workspace-views/workspace-views-model";

let homeDir: string = null;

export function getHomeDir(): string {
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
    // Every agent of the tab, longest-running first (#1033).
    agents: AgentStateInfo[];
    // A Review tab whose PR is merged or closed (#686).
    reviewDone: ReviewDoneMeta;
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
                nameKey: (tab?.meta as Record<string, unknown>)?.[ViewNameKeyMetaKey] ?? null,
            };
        });
    }, [tabId]);
    const urgentAtom = useMemo(() => {
        const tabAtom = getWaveObjectAtom<Tab>(makeORef("tab", tabId));
        return AgentStates.getInstance().tabAtom(atom((get) => get(tabAtom)?.blockids ?? []));
    }, [tabId]);
    const agentsAtom = useMemo(() => {
        const tabAtom = getWaveObjectAtom<Tab>(makeORef("tab", tabId));
        return atom((get) =>
            tabAgentsByRun(agentStatesOfBlocks(get(AgentStates.getInstance().dataAtom), get(tabAtom)?.blockids ?? []))
        );
    }, [tabId]);
    const facts = useAtomValue(identityAtom);
    const urgent = useAtomValue(urgentAtom);
    const agents = useAtomValue(agentsAtom);
    const t = useT();
    const icon = facts.agentId ? AiIcon : panelIcon(facts.meta);
    const shownName =
        facts.pinned && tabName === ProjectTabName
            ? t("project.tabName")
            : viewShownName(tabName, { [ViewNameKeyMetaKey]: facts.nameKey }, t);
    return {
        name: tabDisplayName(shownName, facts.meta, getHomeDir()),
        icon,
        pinned: facts.pinned,
        agent: urgent,
        agents: facts.pinned ? [] : agents,
        reviewDone: panelReviewDone(facts.meta),
    };
}

// The tab's tooltip: the Review tab's done hint, the tab's agents (#1033), then the trees of its terminals. now dates
// the agents' run times (the tab refreshes it on hover).
export function tabTooltip(t: TFunction, identity: TabIdentity, treesTitle: string, now = Date.now()): string {
    return [reviewDoneTabTitle(t, identity.reviewDone), tabAgentsTitle(t, identity.agents, now), treesTitle]
        .filter((s) => !!s)
        .join("\n");
}

export function useTabTooltip(identity: TabIdentity, treesTitle: string, now?: number): string {
    const t = useT();
    return tabTooltip(t, identity, treesTitle, now);
}

// The agent the tab names after its name (#1033), quieter than the name: "· Valentin +2". Its first name ellipsizes
// only once the tab's name has given up its room (tab-bar.css).
export function TabAgentName({ agents }: { agents: AgentStateInfo[] }) {
    const t = useT();
    const named = tabAgentName(agents);
    if (named == null) {
        return null;
    }
    return (
        <span className="molten-tab-agent" data-testid="tab-agent-name">
            <span className="molten-tab-agent-sep" aria-hidden="true">
                ·
            </span>
            <span className="molten-tab-agent-name">{named.name}</span>
            {named.more > 0 && (
                <span className="molten-tab-agent-more">{t("tabs.agent.more", { count: named.more })}</span>
            )}
        </span>
    );
}

// The done mark of a Review tab (#686): a check in the success colour once merged, a neutral dash once closed.
export function TabReviewMark({ done }: { done: ReviewDoneMeta }) {
    const t = useT();
    if (done == null) {
        return null;
    }
    const title = reviewDoneTabTitle(t, done);
    return (
        <i
            className={cn(
                "fa fa-solid molten-tab-review-done",
                done.state === "merged" ? "fa-circle-check" : "fa-circle-minus"
            )}
            data-state={done.state}
            role="img"
            aria-label={title}
            title={title}
            data-testid="tab-review-done"
        />
    );
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
    const working = info?.state === "working";
    useWorkingBeat(working);
    if (info == null) {
        return null;
    }
    const title = agentMarkTitle(info);
    return (
        <span
            className={cn("molten-tab-dot", working && "mt-beat-turn")}
            data-state={info.state}
            role="img"
            aria-label={title}
            title={title}
            data-testid="tab-agent-mark"
        />
    );
}
