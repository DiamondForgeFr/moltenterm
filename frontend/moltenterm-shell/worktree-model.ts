// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Worktree per terminal (FR-SHELL-016): what a terminal's header, the status bar and the tab tooltip say about the
// tree a terminal works in, when the link is offered, and the plan shown before a worktree is removed. Kept apart from
// the components so the rules can be tested without the app.

import type { PaneState } from "./status-bar-model";
import { pathBaseName } from "./workspace-project";

// must match WorktreeMetaKey and WorktreeDismissedMetaKey in pkg/molten/worktree.go
export const WorktreeMetaKey = "molten:worktree";
export const WorktreeDismissedMetaKey = "molten:worktreedismissed";

export type TreeKind = "main" | "worktree" | "missing";

export type TreeMarker = {
    kind: TreeKind;
    // The worktree's folder name, or "main tree" / "missing worktree".
    label: string;
    branch: string;
    path: string;
    // The worktree is linked to this terminal (it owns it).
    linked: boolean;
    // A linked terminal whose folder is now elsewhere.
    outside: boolean;
    colorClass: string;
    icon: string;
    title: string;
};

// Two terminals on the same worktree show the same colour: it is drawn from the path.
const WorktreeColors = [
    "text-sky-300 border-sky-400/50 bg-sky-400/10",
    "text-violet-300 border-violet-400/50 bg-violet-400/10",
    "text-emerald-300 border-emerald-400/50 bg-emerald-400/10",
    "text-pink-300 border-pink-400/50 bg-pink-400/10",
    "text-teal-300 border-teal-400/50 bg-teal-400/10",
    "text-lime-300 border-lime-400/50 bg-lime-400/10",
    "text-fuchsia-300 border-fuchsia-400/50 bg-fuchsia-400/10",
    "text-cyan-300 border-cyan-400/50 bg-cyan-400/10",
];
const MainTreeColor = "text-secondary border-border bg-transparent";
const MissingColor = "text-warning border-warning/50 bg-warning/10";

export const MainTreeIcon = "house";
export const WorktreeIcon = "code-fork";
export const MissingWorktreeIcon = "triangle-exclamation";

export function worktreeColor(path: string): string {
    let hash = 2166136261;
    for (let i = 0; i < (path ?? "").length; i++) {
        hash ^= path.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return WorktreeColors[(hash >>> 0) % WorktreeColors.length];
}

export function readWorktreeLink(meta: Record<string, any>): string {
    const value = meta?.[WorktreeMetaKey];
    return typeof value === "string" ? value : "";
}

export function readWorktreeDismissed(meta: Record<string, any>): string[] {
    const value = meta?.[WorktreeDismissedMetaKey];
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

function branchOf(state: { branch?: string; detached?: boolean; sha?: string }): string {
    if (state?.branch) {
        return state.branch;
    }
    return state?.detached ? (state.sha ?? "").slice(0, 7) : "";
}

// The tree a terminal shows. state is the pane probe's answer for the terminal's folder (null while it is asked);
// link the worktree the terminal is linked to. No marker outside a repository, unless the terminal has a link.
export function treeMarker(state: PaneState, link: string): TreeMarker {
    if (link) {
        const name = pathBaseName(link);
        if (state?.linked?.missing) {
            return {
                kind: "missing",
                label: "missing worktree",
                branch: "",
                path: link,
                linked: true,
                outside: false,
                colorClass: MissingColor,
                icon: MissingWorktreeIcon,
                title: `Missing worktree: ${link} was removed outside MoltenTerm.\nClick to unlink this terminal.`,
            };
        }
        const branch = state?.linked?.branch ?? "";
        const outside = state != null && state.root !== link;
        const lines = [`Worktree ${name}${branch ? ` on ${branch}` : ""}, linked to this terminal`, link];
        if (outside && state?.dir) {
            lines.push(`This terminal is now in ${state.dir}, outside its worktree.`);
        }
        if (state?.linked?.dirty) {
            lines.push("uncommitted changes");
        }
        lines.push("Closing the terminal offers to remove the worktree.");
        return {
            kind: "worktree",
            label: name,
            branch,
            path: link,
            linked: true,
            outside,
            colorClass: worktreeColor(link),
            icon: WorktreeIcon,
            title: lines.join("\n"),
        };
    }
    if (state?.root && state.worktree) {
        const name = pathBaseName(state.root);
        const branch = branchOf(state);
        return {
            kind: "worktree",
            label: name,
            branch,
            path: state.root,
            linked: false,
            outside: false,
            colorClass: worktreeColor(state.root),
            icon: WorktreeIcon,
            title: [
                `Worktree ${name}${branch ? ` on ${branch}` : ""}, not linked to this terminal`,
                state.root,
                state.project ? `of ${state.project}` : "",
            ]
                .filter((s) => s)
                .join("\n"),
        };
    }
    if (state?.root) {
        const branch = branchOf(state);
        return {
            kind: "main",
            label: "main tree",
            branch,
            path: state.root,
            linked: false,
            outside: false,
            colorClass: MainTreeColor,
            icon: MainTreeIcon,
            title: [`Main tree, no worktree${branch ? ` (${branch})` : ""}`, state.root].join("\n"),
        };
    }
    return null;
}

// The link is offered when the terminal's folder is in a worktree it is not linked to, and the user did not answer
// "Not now" for that worktree in this terminal. The main tree never gets an offer.
export function worktreeOffer(state: PaneState, link: string, dismissed: readonly string[]): string {
    if (!state?.root || !state.worktree) {
        return "";
    }
    if (state.root === link || dismissed.includes(state.root)) {
        return "";
    }
    return state.root;
}

export function withWorktreeDismissed(dismissed: readonly string[], path: string): string[] {
    return dismissed.includes(path) ? [...dismissed] : [...dismissed, path];
}

// One line of the tab tooltip.
export function treeTooltipLine(marker: TreeMarker): string {
    if (marker == null) {
        return "";
    }
    if (marker.kind === "missing") {
        return `missing worktree (${marker.path})`;
    }
    const branch = marker.branch ? ` · ${marker.branch}` : "";
    if (marker.kind === "main") {
        return `main tree${branch}`;
    }
    return `worktree ${marker.label}${branch}${marker.linked ? "" : " (not linked)"}`;
}

export function tabTreesTooltip(lines: string[]): string {
    const shown = lines.filter((l) => l);
    if (shown.length === 0) {
        return "";
    }
    return ["Trees:", ...shown.map((l) => `• ${l}`)].join("\n");
}

// must match WorktreePlan and WorktreeRemoveResult in pkg/molten/mission/worktree.go
export type WorktreeTerminal = { blockid: string; tab?: string; workspace?: string; linked?: boolean };
export type WorktreePlan = {
    path: string;
    missing?: boolean;
    main?: string;
    branch?: string;
    sha?: string;
    detached?: boolean;
    locked?: boolean;
    changes: string[];
    changecount: number;
    ignored: string[];
    ignoredcount: number;
    unpushed: number;
    noremote?: boolean;
    trunk?: string;
    merged?: boolean;
    protected?: boolean;
    terminals: WorktreeTerminal[];
};
export type WorktreeRemoveResult = { removed: boolean; forced?: boolean; branchdeleted?: string; branchkept?: string };

export type ClosePlanView = {
    // Uncommitted changes or commits no remote has: removal needs a second confirmation.
    atRisk: boolean;
    // Other terminals use the worktree: Keep is the default.
    shared: boolean;
    defaultChoice: "remove" | "keep";
    branchLine: string;
    changesLine: string;
    unpushedLine: string;
    mergedLine: string;
    ignoredLine: string;
    terminalsLine: string;
    // The branch can be deleted with the worktree: merged and not a long-lived branch.
    canDeleteBranch: boolean;
    canRemove: boolean;
    blockedReason: string;
};

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

export function closePlanView(plan: WorktreePlan): ClosePlanView {
    const changes = plan.changecount ?? 0;
    const unpushed = plan.unpushed ?? 0;
    const atRisk = changes > 0 || unpushed > 0;
    const terminals = plan.terminals ?? [];
    const shared = terminals.length > 0;
    const branch = plan.branch || (plan.detached ? `detached at ${(plan.sha ?? "").slice(0, 7)}` : "");
    let mergedLine = "";
    if (plan.branch) {
        if (plan.protected) {
            mergedLine = `${plan.branch} is a long-lived branch: it is kept`;
        } else if (plan.merged == null) {
            mergedLine = plan.trunk
                ? `could not tell whether ${plan.branch} is merged into ${plan.trunk}`
                : "no trunk to compare with";
        } else {
            mergedLine = plan.merged ? `merged: its content is on ${plan.trunk}` : `not merged into ${plan.trunk}`;
        }
    }
    let unpushedLine = "no unpushed commits";
    if (unpushed > 0) {
        if (plan.detached) {
            unpushedLine = `${plural(unpushed, "commit", "commits")} on no branch: lost with the worktree`;
        } else if (plan.noremote) {
            unpushedLine = `${plural(unpushed, "commit", "commits")} on no other branch (no remote)`;
        } else {
            unpushedLine = `${plural(unpushed, "commit", "commits")} on no remote`;
        }
    }
    const terminalsLine = shared
        ? `Also used by ${plural(terminals.length, "other terminal", "other terminals")}: ${terminals
              .map((t) => [t.workspace, t.tab].filter((s) => s).join(" › ") || "a terminal")
              .join(", ")}`
        : "";
    return {
        atRisk,
        shared,
        defaultChoice: shared ? "keep" : "remove",
        branchLine: branch,
        changesLine:
            changes > 0 ? `${plural(changes, "uncommitted change", "uncommitted changes")}` : "no uncommitted changes",
        unpushedLine,
        mergedLine,
        ignoredLine:
            (plan.ignoredcount ?? 0) > 0
                ? `${plural(plan.ignoredcount, "ignored entry", "ignored entries")} removed too: ${plan.ignored.join(", ")}${plan.ignoredcount > plan.ignored.length ? ", …" : ""}`
                : "",
        terminalsLine,
        canDeleteBranch: !!plan.branch && !plan.protected && plan.merged === true,
        canRemove: !plan.locked && !plan.missing,
        blockedReason: plan.locked ? "The worktree is locked (git worktree lock): MoltenTerm keeps it." : "",
    };
}
