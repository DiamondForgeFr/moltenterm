// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Outdated terminals (FR-SHELL-041, DS-SHELL-076): what wavesrv's terminal update route answers and the words the
// header chip, its dialog and the palette use. Pure functions, tested without the app.

import { t } from "../i18n/i18n";
import type { ServerText } from "../i18n/server-text";
import { termupdateMessage } from "./termupdate-text";

// must match pkg/molten/termupdate/termupdate.go
export const TermUpdateRoute = "molten:termupdate";
export const TermUpdateEvent = "molten:termupdate";
export const TermUpdateListCommand = "moltentermupdatelist";
export const TermUpdateCheckCommand = "moltentermupdatecheck";
export const TermUpdateRunCommand = "moltentermupdaterun";

// previouslogin: started before the current login on this computer, so cut off from the network (#1194).
export type OutdatedReason = "nogeneration" | "oldergeneration" | "agentbeforerefresh" | "previouslogin";

export type OutdatedTerminal = {
    blockid: string;
    reason: OutdatedReason;
    generation: number;
    current: number;
    agent?: string;
    agentname?: string;
};

export type OutdatedData = { terminals: OutdatedTerminal[]; version: number };

export const EmptyOutdated: OutdatedData = { terminals: [], version: 0 };

export type TermUpdateStatus =
    | "ready"
    | "needconfirm"
    | "busy"
    | "agentbusy"
    | "agentstuck"
    | "updated"
    | "uptodate"
    | "unavailable"
    | "failed";

export type TermUpdateOutcome = {
    status: TermUpdateStatus;
    message: string;
    messagetext?: ServerText;
    agent?: string;
    agentname?: string;
    program?: string;
    command?: string;
    guessed?: boolean;
};

// A newer list replaces the one held; an older one (an event overtaken by the snapshot) is dropped.
export function applyOutdated(current: OutdatedData, next: OutdatedData): OutdatedData {
    if (next == null) {
        return current;
    }
    if (current != null && current.version > 0 && next.version > 0 && next.version < current.version) {
        return current;
    }
    return { terminals: next.terminals ?? [], version: next.version ?? 0 };
}

export function outdatedOfBlock(data: OutdatedData, blockId: string): OutdatedTerminal {
    return data?.terminals?.find((t) => t.blockid === blockId) ?? null;
}

// The chip's hover: why this terminal is behind, and what the action does.
export function outdatedTitle(term: OutdatedTerminal): string {
    if (term == null) {
        return "";
    }
    const name = term.agentname || term.agent;
    const lines: string[] = [];
    if (term.reason === "previouslogin") {
        lines.push(name ? t("termupdate.title.agentNoNetwork", { agent: name }) : t("termupdate.title.noNetwork"));
    } else if (name) {
        lines.push(t("termupdate.title.agentStarted", { agent: name }));
    } else if (term.reason === "nogeneration") {
        lines.push(t("termupdate.title.olderShell"));
    } else {
        lines.push(t("termupdate.title.olderEnv"));
    }
    if (name) {
        lines.push(t("termupdate.title.agentAction", { agent: name }));
    } else {
        lines.push(t("termupdate.title.shellAction"));
    }
    return lines.join("\n");
}

export function previousLoginBlockIds(data: OutdatedData): Set<string> {
    return new Set((data?.terminals ?? []).filter((t) => t.reason === "previouslogin").map((t) => t.blockid));
}

// The header proposal's label: a terminal cut off from the network says so, the others offer the update.
export function updateProposalLabel(term: OutdatedTerminal): string {
    return term?.reason === "previouslogin"
        ? t("cmdpanel.proposals.restartNoNetwork")
        : t("cmdpanel.proposals.updateTerminal");
}

// The restart dialog's line under its title.
export function restartDialogSubtitle(reason: OutdatedReason): string {
    return reason === "previouslogin" ? t("termupdate.dialog.subtitleNoNetwork") : t("termupdate.dialog.subtitle");
}

// What the palette entry says it will do.
export function updateAllDetail(count: number): string {
    if (count <= 0) {
        return "";
    }
    return count === 1 ? t("termupdate.detail.one") : t("termupdate.detail.other", { count });
}

// The palette's summary once it ran: what was updated, what was left and why.
export function updateAllSummary(results: { blockid: string; outcome: TermUpdateOutcome }[]): {
    title: string;
    message: string;
    kind: "success" | "warning";
} {
    const updated = results.filter((r) => r.outcome?.status === "updated").length;
    const left = results.filter((r) => r.outcome?.status !== "updated" && r.outcome?.status !== "uptodate");
    const title =
        updated === 1
            ? t("termupdate.summary.updatedOne")
            : updated > 1
              ? t("termupdate.summary.updatedOther", { count: updated })
              : t("termupdate.summary.updatedNone");
    if (left.length === 0) {
        return { title, message: "", kind: "success" };
    }
    // Terminals left for the same reason (several running Claude Code) make one sentence.
    const reasons = Array.from(
        new Set(left.map((r) => termupdateMessage(r.outcome) || t("termupdate.summary.couldNotUpdate")))
    );
    const lead =
        left.length === 1 ? t("termupdate.summary.leftOne") : t("termupdate.summary.leftOther", { count: left.length });
    return {
        title,
        message: t("termupdate.summary.leftMessage", { lead, reasons: reasons.join(" ") }),
        kind: "warning",
    };
}

// Terminals the palette updates without asking: those with no agent (an agent needs its own confirmation).
export function updatableWithoutAsking(data: OutdatedData): OutdatedTerminal[] {
    return (data?.terminals ?? []).filter((t) => !t.agent);
}
