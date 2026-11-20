// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hook setup offer (#221): wavesrv owns detection and all mutation decisions. Claude/Codex remain manual recipes;
// qualified persistent providers expose the same offer through an approval dialog and Integration management. Kept
// apart from the store and components so the rules can be tested without the app.

import { AgentStateInfo } from "./agent-state-model";

// must match pkg/molten/agenthooks.go
export const AgentHookOfferCommand = "moltenagenthookoffer";
export const AgentHookDismissCommand = "moltenagenthookdismiss";
export const AgentHookApplyCommand = "moltenagenthookapply";
export const AgentHookRemoveCommand = "moltenagenthookremove";
export const AgentStatesDocCommand = "moltenagentstatesdoc";

// must match AgentHookOffer in pkg/molten/agenthooks.go
export type AgentHookOffer = {
    blockid: string;
    agent?: string;
    agentname?: string;
    show: boolean;
    reason?: string;
    file?: string;
    also?: string;
    brings?: string;
    language?: string;
    snippet?: string;
    persistent?: boolean;
    status?:
        | "absent"
        | "current"
        | "definition-update"
        | "compatibility-review"
        | "drift"
        | "invalid"
        | "conflict"
        | "manual"
        | "installed-not-reporting"
        | "reporting";
    action?: "install" | "update" | "repair" | "review" | "remove";
    updatekind?: "definition" | "compatibility" | "repair";
    updatekey?: string;
    definitionversion?: number;
    definitionsha256?: string;
    installeddefinitionversion?: number;
    installeddefinitionsha256?: string;
    installedkimiversion?: string;
    currentkimiversion?: string;
    qualifiedkimiversion?: string;
    events?: string[];
    managed?: boolean;
    configdigest?: string;
    canapply?: boolean;
    canremove?: boolean;
    errorcode?: string;
    detectionerror?: string;
};

export type AgentHookMutationResult = { offer: AgentHookOffer; backuppath?: string };

export function hookDismissalId(agent: string, updateKey?: string): string {
    return updateKey ? `${agent}:${updateKey}` : agent;
}

// Proposal visibility is derived from the complete details offer. A report hides only ordinary setup; definition,
// compatibility and repair revisions remain visible. Dismissal never changes the details atom used by Integration.
export function visibleHookOffer(info: AgentStateInfo, offer: AgentHookOffer, dismissed: string[]): AgentHookOffer {
    if (info == null || offer == null || !offer.show) {
        return null;
    }
    if (info.hooked && !offer.updatekind) {
        return null;
    }
    const dismissalId = hookDismissalId(offer.agent, offer.updatekey);
    if (
        offer.agent !== info.agent ||
        (dismissed ?? []).includes(info.agent) ||
        (offer.updatekind && (dismissed ?? []).includes(dismissalId))
    ) {
        return null;
    }
    return offer;
}

// Refresh on an agent change and on its reporting transition. Integration also refreshes whenever it opens.
export function hookOfferQueryKey(info: AgentStateInfo): string {
    if (info == null || !info.agent) {
        return "";
    }
    return `${info.agent}:${info.hooked ? "reporting" : "unreported"}`;
}

// The offer's sentences in the interface language (#988), by agent; wavesrv's English for an agent without keys.
const OfferTextKeys: Record<string, { brings: string; also: string }> = {
    claude: { brings: "agent.hooks.bringsBy.claude", also: "agent.hooks.alsoBy.claude" },
    codex: { brings: "agent.hooks.bringsBy.codex", also: "agent.hooks.alsoBy.codex" },
    kimi: { brings: "agent.hooks.bringsBy.kimi", also: "agent.hooks.alsoBy.kimi" },
};

export function hookOfferTexts(offer: AgentHookOffer, t: (key: string) => string): { brings: string; also: string } {
    const keys = OfferTextKeys[offer?.agent ?? ""];
    if (keys == null) {
        return { brings: offer?.brings ?? "", also: offer?.also ?? "" };
    }
    return { brings: t(keys.brings), also: t(keys.also) };
}

export function dismissedWith(dismissed: string[], agent: string): string[] {
    if (!agent || dismissed.includes(agent)) {
        return dismissed;
    }
    return [...dismissed, agent];
}

export function hookProposalTextKey(offer: AgentHookOffer): string {
    switch (offer?.updatekind) {
        case "definition":
            return "cmdpanel.proposals.updateHooks";
        case "repair":
            return "cmdpanel.proposals.repairHooks";
        case "compatibility":
            return "cmdpanel.proposals.reviewHooks";
    }
    if (offer?.status === "installed-not-reporting") {
        return "cmdpanel.proposals.restartHooks";
    }
    return "cmdpanel.proposals.setupHooks";
}

export function hookApplyTextKey(offer: AgentHookOffer): string {
    switch (offer?.action) {
        case "update":
            return "agent.hooks.update";
        case "repair":
            return "agent.hooks.repair";
        default:
            return "agent.hooks.install";
    }
}
