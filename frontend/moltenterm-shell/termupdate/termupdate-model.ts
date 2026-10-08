// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Outdated terminals (FR-SHELL-041, DS-SHELL-076): what wavesrv's terminal update route answers and the words the
// header chip, its dialog and the palette use. Pure functions, tested without the app.

// must match pkg/molten/termupdate/termupdate.go
export const TermUpdateRoute = "molten:termupdate";
export const TermUpdateEvent = "molten:termupdate";
export const TermUpdateListCommand = "moltentermupdatelist";
export const TermUpdateCheckCommand = "moltentermupdatecheck";
export const TermUpdateRunCommand = "moltentermupdaterun";

export type OutdatedReason = "nogeneration" | "oldergeneration" | "agentbeforerefresh";

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
    | "unavailable"
    | "failed";

export type TermUpdateOutcome = {
    status: TermUpdateStatus;
    message: string;
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
export function outdatedTitle(t: OutdatedTerminal): string {
    if (t == null) {
        return "";
    }
    const name = t.agentname || t.agent;
    const lines: string[] = [];
    if (name) {
        lines.push(`Started before the update: ${name} runs without MoltenTerm's browser and hooks.`);
    } else if (t.reason === "nogeneration") {
        lines.push(
            "This shell was started by an older MoltenTerm: agents started here miss MoltenTerm's browser and hooks."
        );
    } else {
        lines.push("This shell still has an older MoltenTerm environment.");
    }
    if (name) {
        lines.push(`Update terminal restarts ${name} in a fresh shell, on the same conversation.`);
    } else {
        lines.push("Update terminal replaces the shell in the same folder; the scrollback stays.");
    }
    return lines.join("\n");
}

// What the palette entry says it will do.
export function updateAllDetail(count: number): string {
    if (count <= 0) {
        return "";
    }
    return count === 1
        ? "1 terminal started before MoltenTerm's update"
        : `${count} terminals started before MoltenTerm's update`;
}

// The palette's summary once it ran: what was updated, what was left and why.
export function updateAllSummary(results: { blockid: string; outcome: TermUpdateOutcome }[]): {
    title: string;
    message: string;
    kind: "success" | "warning";
} {
    const updated = results.filter((r) => r.outcome?.status === "updated").length;
    const left = results.filter((r) => r.outcome?.status !== "updated");
    const title =
        updated === 1 ? "1 terminal updated" : updated > 1 ? `${updated} terminals updated` : "No terminal updated";
    if (left.length === 0) {
        return { title, message: "", kind: "success" };
    }
    const reasons = left.map((r) => r.outcome?.message || "it could not be updated");
    const lead = left.length === 1 ? "1 terminal was left as it is" : `${left.length} terminals were left as they are`;
    return { title, message: `${lead}: ${reasons.join(" ")}`, kind: "warning" };
}

// Terminals the palette updates without asking: those with no agent (an agent needs its own confirmation).
export function updatableWithoutAsking(data: OutdatedData): OutdatedTerminal[] {
    return (data?.terminals ?? []).filter((t) => !t.agent);
}
