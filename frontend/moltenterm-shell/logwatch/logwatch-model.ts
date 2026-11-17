// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk's log watch (FR-BOSS-012, #2336): what the card's actions do. wavesrv raises the cards
// (pkg/molten/logwatch) and answers the window's two commands, Ask and Mute; this decides what a click does with the
// answer: done, a pick among the running agents, or a plain reason. Pure, so the rules are tested without a window.

// must match RouteId and the commands in pkg/molten/logwatch/route.go
export const LogWatchRouteId = "molten:logwatch";
export const LogWatchAskCommand = "moltenlogwatchask";
export const LogWatchMuteCommand = "moltenlogwatchmute";

// must match AskGesture and MuteGesture in pkg/molten/logwatch/card.go; Show in folder is the built-in path:reveal.
export const LogWatchAskGesture = "molten:logwatch:ask";
export const LogWatchMuteGesture = "molten:logwatch:mute";

// must match the Ask statuses in pkg/molten/logwatch/watch.go
export type LogWatchAskStatus = "sent" | "pick" | "noagent" | "gone" | "refused" | "busy" | "unknown";

// An agent the developer may pick (logwatch.Candidate): always one of MoltenTerm's repository, its worktrees included.
export type LogWatchCandidate = {
    blockid: string;
    firstname: string;
    agentname?: string;
    workspace?: string;
    project?: string;
};

export type LogWatchAskRequest = { id: string; blockid?: string };

export type LogWatchAskResult = {
    status: LogWatchAskStatus;
    to?: string;
    delivery?: string;
    agents?: LogWatchCandidate[];
};

// What a click reports to the card (notifications-store's NotificationGestureResult), with the reason as a key.
export type LogWatchOutcome = { ok: boolean; resolve?: boolean; errorKey?: string; error?: string };

export type LogWatchDeps = {
    // The window's gate (currentLogWatchOn): an internal channel and its switch on.
    on: () => boolean;
    ask: (req: LogWatchAskRequest) => Promise<LogWatchAskResult>;
    mute: (id: string) => Promise<void>;
    // The developer's pick among the agents: a terminal's block id, "" when they cancel.
    pick: (agents: LogWatchCandidate[]) => Promise<string>;
    // A caught error in the interface language (serverErrorText).
    word: (e: unknown) => string;
    // The cards whose request this window is sending: a second click on one sends nothing.
    inflight?: Set<string>;
};

const FailureKeys: Partial<Record<LogWatchAskStatus, string>> = {
    noagent: "logwatch.noAgent",
    gone: "logwatch.gone",
    refused: "logwatch.refused",
    unknown: "logwatch.unknown",
};

export function askFailureKey(status: LogWatchAskStatus): string {
    return FailureKeys[status] ?? null;
}

// The card's signature id, from its action's args; "" when there is none.
export function readCardId(args: Record<string, unknown>): string {
    const id = args?.id;
    return typeof id === "string" ? id.trim() : "";
}

// Ask an agent to look: one request; with no lead that stands out, the developer picks, and a cancelled pick sends
// nothing and says nothing. A second click while the first is on its way (here or, for wavesrv's "busy", in another
// window) sends nothing either.
export async function runAsk(deps: LogWatchDeps, args: Record<string, unknown>): Promise<LogWatchOutcome> {
    if (!deps.on()) {
        return { ok: false, errorKey: "logwatch.unavailable" };
    }
    const id = readCardId(args);
    if (id === "") {
        return { ok: false, errorKey: "logwatch.unknown" };
    }
    if (deps.inflight?.has(id)) {
        return { ok: true };
    }
    deps.inflight?.add(id);
    try {
        return await askOnce(deps, id);
    } finally {
        deps.inflight?.delete(id);
    }
}

async function askOnce(deps: LogWatchDeps, id: string): Promise<LogWatchOutcome> {
    try {
        let result = await deps.ask({ id });
        if (result?.status === "pick") {
            const blockid = await deps.pick(result.agents ?? []);
            if (!blockid) {
                return { ok: true };
            }
            result = await deps.ask({ id, blockid });
        }
        const key = askFailureKey(result?.status);
        if (key != null) {
            return { ok: false, errorKey: key };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: deps.word(e) };
    }
}

// Ignore this kind: that signature raises nothing more, and its card closes.
export async function runMute(deps: LogWatchDeps, args: Record<string, unknown>): Promise<LogWatchOutcome> {
    if (!deps.on()) {
        return { ok: false, errorKey: "logwatch.unavailable" };
    }
    const id = readCardId(args);
    if (id === "") {
        return { ok: false, errorKey: "logwatch.unknown" };
    }
    try {
        await deps.mute(id);
        return { ok: true, resolve: true };
    } catch (e) {
        return { ok: false, error: deps.word(e) };
    }
}

// The details of an agent in the pick, after its first name: its agent, workspace and project, the empty ones left out.
export function candidateDetails(c: LogWatchCandidate): string {
    return [c.agentname, c.workspace, c.project].filter((part) => (part ?? "").trim() !== "").join(" · ");
}
