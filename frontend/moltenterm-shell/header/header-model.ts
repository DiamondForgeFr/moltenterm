// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The panel header's rules (FR-SHELL-052, DS-SHELL-093): [16 px icon] Title (12/600), muted context (folder, branch
// once, the connection only when remote), then at most one Pill. Kept apart from the components so the choice of the
// pill and the context can be tested without the app.

import type { AgentStateInfo } from "../agent-state-model";
import type { TreeMarker } from "../worktree-model";

export const QuestionMaxChars = 48;

export type PillTone = "neutral" | "warning" | "danger";

// When several states apply, the most urgent wins: waiting > error > auto-approve > remote > durable (DS-SHELL-093).
// Auto-approve ships with #386. Multi input (Wave's broadcast to every terminal of the tab) sits with the errors: a
// keystroke goes to other terminals too.
export type HeaderPillKind = "waiting" | "error" | "missingworktree" | "multiinput" | "remote" | "durable";

export const HeaderPillOrder: HeaderPillKind[] = [
    "waiting",
    "error",
    "missingworktree",
    "multiinput",
    "remote",
    "durable",
];

export type HeaderPillSpec = {
    kind: HeaderPillKind;
    tone: PillTone;
    label: string;
    // The full text on hover (a waiting agent's whole question).
    title: string;
    dot?: boolean;
    icon?: string;
    // The verb of the trailing action ("Go"), when the pill has one.
    action?: string;
};

// The question of a waiting agent on one line, cut at max characters (ellipsis included), never inside a surrogate
// pair.
export function truncateQuestion(text: string, max: number = QuestionMaxChars): string {
    const line = (text ?? "").replace(/\s+/g, " ").trim();
    const chars = Array.from(line);
    if (chars.length <= max) {
        return line;
    }
    return (
        chars
            .slice(0, max - 1)
            .join("")
            .trimEnd() + "…"
    );
}

export function waitingPill(agent: AgentStateInfo): HeaderPillSpec {
    if (agent?.state !== "waiting") {
        return null;
    }
    const name = agent.agentname || agent.agent || "The agent";
    const question = (agent.message ?? "").replace(/\s+/g, " ").trim();
    // FR-SHELL-052 validation rule: with no text from the Notification hook, the pill says Waiting.
    const label = question ? truncateQuestion(question) : "Waiting";
    return {
        kind: "waiting",
        tone: "warning",
        label,
        title: question ? `${name} asks: ${question}` : `${name} is waiting for you`,
        dot: true,
        action: "Go",
    };
}

export function agentErrorPill(agent: AgentStateInfo): HeaderPillSpec {
    if (agent?.state !== "error") {
        return null;
    }
    const name = agent.agentname || agent.agent || "The agent";
    const message = (agent.message ?? "").replace(/\s+/g, " ").trim();
    return {
        kind: "error",
        tone: "danger",
        label: message ? truncateQuestion(message) : "Error",
        title: message ? `${name}: ${message}` : `${name} stopped on an error`,
        dot: true,
    };
}

export function missingWorktreePill(marker: TreeMarker): HeaderPillSpec {
    if (marker?.kind !== "missing") {
        return null;
    }
    return {
        kind: "missingworktree",
        tone: "danger",
        label: "Missing worktree",
        title: marker.title,
        icon: marker.icon,
        action: "Unlink",
    };
}

export function multiInputPill(on: boolean): HeaderPillSpec {
    if (!on) {
        return null;
    }
    return {
        kind: "multiinput",
        tone: "warning",
        label: "Multi input",
        title: "Input is sent to all the terminals of this tab (click to stop)",
        icon: "keyboard",
    };
}

export type RemoteConnStatus = Pick<ConnStatus, "status" | "connected" | "connhealthstatus" | "wshenabled" | "error">;

// A remote panel's connection only takes the pill when something is wrong with it; a healthy one is just the muted
// host in the context.
export function remotePill(connection: string, isLocal: boolean, status: RemoteConnStatus): HeaderPillSpec {
    if (isLocal || !connection) {
        return null;
    }
    if (status?.status === "connecting") {
        return { kind: "remote", tone: "neutral", label: "Connecting", title: `Connecting to ${connection}` };
    }
    if (status?.status === "error") {
        const why = status.error ? ` (${status.error})` : "";
        return {
            kind: "remote",
            tone: "danger",
            label: "Can't connect",
            title: `Error connecting to ${connection}${why}`,
        };
    }
    if (!status?.connected) {
        return { kind: "remote", tone: "neutral", label: "Disconnected", title: `Disconnected from ${connection}` };
    }
    if (status.connhealthstatus === "degraded" || status.connhealthstatus === "stalled") {
        const label = status.connhealthstatus === "degraded" ? "Degraded" : "Stalled";
        return { kind: "remote", tone: "warning", label, title: `Connection ${label.toLowerCase()}: ${connection}` };
    }
    if (status.status === "connected" && !status.wshenabled) {
        return {
            kind: "remote",
            tone: "neutral",
            label: "No wsh",
            title: `wsh is not installed for ${connection}`,
        };
    }
    return null;
}

const DurableStates: Record<string, { label: string; title: string }> = {
    disconnected: { label: "Detached", title: "Durable session, detached: the shell keeps running." },
    init: { label: "Starting", title: "Durable session, starting." },
    done: { label: "Session ended", title: "Durable session, ended." },
};

// The durability itself is set in the command panel's MoltenTerm section. Local terminals are durable by default
// (#72), so an attached durable session is the normal case and takes no pill; the pill only names a session that is
// detached, starting or ended.
export function durablePill(configured: boolean, jobStatus: string): HeaderPillSpec {
    const state = DurableStates[jobStatus];
    if (configured !== true || state == null) {
        return null;
    }
    return {
        kind: "durable",
        tone: "neutral",
        label: state.label,
        title: `${state.title}\nClick for the session's options.`,
        icon: "shield",
    };
}

export function pickHeaderPill(candidates: HeaderPillSpec[]): HeaderPillSpec {
    let best: HeaderPillSpec = null;
    for (const c of candidates) {
        if (c == null) {
            continue;
        }
        if (best == null || HeaderPillOrder.indexOf(c.kind) < HeaderPillOrder.indexOf(best.kind)) {
            best = c;
        }
    }
    return best;
}

export type HeaderContextPart = { key: string; text: string; title?: string; icon?: string; iconClass?: string };

// The tree's colour on its icon only: the context stays muted text, never a chip.
function textColorOf(classes: string): string {
    return (classes ?? "").split(/\s+/).find((c) => c.startsWith("text-")) ?? "";
}

// A local terminal's context: the project (or the folder), then the branch, once. A worktree shows its tree icon in
// front of the branch; its name and path stay in the tooltip.
export function termContextParts(input: {
    folder: string;
    projectName: string;
    projectTitle?: string;
    branch: string;
    branchTitle?: string;
    marker: TreeMarker;
}): HeaderContextPart[] {
    const parts: HeaderContextPart[] = [];
    if (input.projectName) {
        parts.push({ key: "project", text: input.projectName, title: input.projectTitle || input.folder });
    }
    const marker = input.marker;
    const worktree = marker?.kind === "worktree";
    const branch = input.branch || (worktree ? marker.branch : "");
    if (branch) {
        const title = [worktree ? marker.title : "", input.branchTitle].filter((s) => !!s).join("\n");
        parts.push({
            key: "branch",
            text: branch,
            title: title || branch,
            icon: worktree ? marker.icon : undefined,
            iconClass: worktree ? textColorOf(marker.colorClass) : undefined,
        });
    } else if (worktree) {
        parts.push({ key: "branch", text: marker.label, title: marker.title, icon: marker.icon });
    }
    return parts;
}

// The title of a terminal's header: the agent running in it, else the panel's own title, else "Terminal".
export function termHeaderTitle(agent: AgentStateInfo, frameTitle: string, viewName: string): string {
    if (agent != null) {
        return agent.agentname || agent.agent || "Agent";
    }
    return frameTitle || viewName || "Terminal";
}
