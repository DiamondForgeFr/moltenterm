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
import { TFunction, useT } from "./i18n/i18n";
import { ProjectTabMetaKey, ProjectTabName } from "./project/project-model";
import { ReviewDoneMeta, reviewDoneTabTitle } from "./review/review-done";
import { agentGlyph, panelIcon, PanelMeta, panelReviewDone, tabDisplayName } from "./tab-identity";
import { useWorkingBeat } from "./working-beat";

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
    const t = useT();
    const presets = fullConfig?.presets as Record<string, Record<string, unknown>>;
    const icon = facts.agentId ? agentGlyph(facts.agentId, presets) : panelIcon(facts.meta);
    const shownName = facts.pinned && tabName === ProjectTabName ? t("project.tabName") : tabName;
    return {
        name: tabDisplayName(shownName, facts.meta, getHomeDir()),
        icon,
        pinned: facts.pinned,
        agent: urgent,
        reviewDone: panelReviewDone(facts.meta),
    };
}

// The tab's tooltip: the Review tab's done hint above the trees of its terminals.
export function tabTooltip(t: TFunction, identity: TabIdentity, treesTitle: string): string {
    return [reviewDoneTabTitle(t, identity.reviewDone), treesTitle].filter((s) => !!s).join("\n");
}

export function useTabTooltip(identity: TabIdentity, treesTitle: string): string {
    const t = useT();
    return tabTooltip(t, identity, treesTitle);
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
            className={cn("molten-tab-dot", working && "mt-beat-blink")}
            data-state={info.state}
            role="img"
            aria-label={title}
            title={title}
            data-testid="tab-agent-mark"
        />
    );
}
