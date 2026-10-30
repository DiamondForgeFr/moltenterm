// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The panel header's rules (FR-SHELL-052, DS-SHELL-093): [16 px icon] Title (12/600), muted context (folder, branch
// once, the connection only when remote), then at most one Pill. Kept apart from the components so the choice of the
// pill and the context can be tested without the app.

import { agentCallName, agentLabel, type AgentStateInfo } from "../agent-state-model";
import { labelled, t } from "../i18n/i18n";
import type { TreeMarker } from "../worktree-model";

export const QuestionMaxChars = 48;

export type PillTone = "neutral" | "warning" | "waiting" | "danger";

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
    const name = agentCallName(agent, t("shell.header.theAgent"));
    const question = (agent.message ?? "").replace(/\s+/g, " ").trim();
    // FR-SHELL-052 validation rule: with no text from the Notification hook, the pill says Waiting.
    const label = question ? truncateQuestion(question) : t("shell.header.waiting");
    return {
        kind: "waiting",
        tone: "waiting",
        label,
        title: question ? t("shell.header.asks", { name, question }) : t("shell.header.waitingForYou", { name }),
        dot: true,
        action: t("shell.header.go"),
    };
}

export function agentErrorPill(agent: AgentStateInfo): HeaderPillSpec {
    if (agent?.state !== "error") {
        return null;
    }
    const name = agentCallName(agent, t("shell.header.theAgent"));
    const message = (agent.message ?? "").replace(/\s+/g, " ").trim();
    return {
        kind: "error",
        tone: "danger",
        label: message ? truncateQuestion(message) : t("shell.header.error"),
        title: message ? labelled(name, message) : t("shell.header.stoppedOnError", { name }),
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
        label: t("shell.header.missingWorktree"),
        title: marker.title,
        icon: marker.icon,
        action: t("shell.header.unlink"),
    };
}

export function multiInputPill(on: boolean): HeaderPillSpec {
    if (!on) {
        return null;
    }
    return {
        kind: "multiinput",
        tone: "warning",
        label: t("shell.header.multiInput"),
        title: t("shell.header.multiInputTitle"),
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
        return {
            kind: "remote",
            tone: "neutral",
            label: t("shell.header.connecting"),
            title: t("shell.header.connectingTo", { connection }),
        };
    }
    if (status?.status === "error") {
        const why = status.error ? ` (${status.error})` : "";
        return {
            kind: "remote",
            tone: "danger",
            label: t("shell.header.cantConnect"),
            title: t("shell.header.errorConnecting", { connection }) + why,
        };
    }
    if (!status?.connected) {
        return {
            kind: "remote",
            tone: "neutral",
            label: t("shell.header.disconnected"),
            title: t("shell.header.disconnectedFrom", { connection }),
        };
    }
    if (status.connhealthstatus === "degraded" || status.connhealthstatus === "stalled") {
        const degraded = status.connhealthstatus === "degraded";
        return {
            kind: "remote",
            tone: "warning",
            label: t(degraded ? "shell.header.degraded" : "shell.header.stalled"),
            title: t(degraded ? "shell.header.connectionDegraded" : "shell.header.connectionStalled", { connection }),
        };
    }
    if (status.status === "connected" && !status.wshenabled) {
        return {
            kind: "remote",
            tone: "neutral",
            label: t("shell.header.noWsh"),
            title: t("shell.header.noWshTitle", { connection }),
        };
    }
    return null;
}

// Dictionary keys.
const DurableStates: Record<string, { label: string; title: string }> = {
    disconnected: { label: "shell.header.durable.detached", title: "shell.header.durable.detachedTitle" },
    init: { label: "shell.header.durable.starting", title: "shell.header.durable.startingTitle" },
    done: { label: "shell.header.durable.ended", title: "shell.header.durable.endedTitle" },
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
        label: t(state.label),
        title: `${t(state.title)}\n${t("shell.header.durable.clickForOptions")}`,
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
        return agentLabel(agent);
    }
    return frameTitle || viewName || t("shell.header.terminal");
}
