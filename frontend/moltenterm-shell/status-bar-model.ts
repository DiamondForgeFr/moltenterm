// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the status bar shows: the focused pane's project, branch, CI verdict and pull request on the left
// (FR-SHELL-010), the build of Moltenterm that runs as one badge on the right (FR-SHELL-008). Kept apart from the
// components so the rules can be tested without the app.

import { BuildChannel, makeBuildIdentity } from "./build/build-identity";
import type { MoltentermBuildInfo } from "./build/build-info";
import {
    checkAbsolutePath,
    checkPathInside,
    effectiveWorkspaceFolder,
    pathBaseName,
    readWorkspaceProject,
} from "./workspace-project";

export type StatusBarChannel = BuildChannel;

// The dev channel's text colour, shared by the status bar badge and the widget bar's dev icon.
export const MoltentermDevChannelText = "text-sky-300";

export type StatusBarView = {
    channel: StatusBarChannel;
    channelLabel: string;
    // The single build badge: the channel of a local build ("Gold"), the version of a release (#187).
    badge: string;
    version: string;
    tooltip: string;
};

export function makeStatusBarView(
    build: MoltentermBuildInfo,
    opts: { isDev: boolean; runtimeChannel?: string; version: string }
): StatusBarView {
    const identity = makeBuildIdentity(build, opts);
    const tooltipLines = [
        `MoltenTerm ${identity.version || "(unknown version)"}, based on Wave Terminal ${identity.waveBase}`,
        identity.buildLine,
    ];
    if (build?.builtAt) {
        tooltipLines.push(`built ${build.builtAt}`);
    }
    if (identity.commitLine) {
        tooltipLines.push(identity.commitLine);
    }
    return {
        channel: identity.channel,
        channelLabel: identity.channelLabel,
        badge: identity.badge,
        version: identity.version,
        tooltip: tooltipLines.filter((s) => s).join("\n"),
    };
}

// must match PaneState in pkg/molten/mission/pane.go
export type PaneState = {
    dir: string;
    root?: string;
    project?: string;
    name?: string;
    logo?: string;
    branch?: string;
    sha?: string;
    detached?: boolean;
    upstream?: string;
    ahead?: number;
    behind?: number;
    dirty?: boolean;
    ci?: string;
    pr?: { number: number; title: string; url: string; draft?: boolean };
    giterror?: string;
    at?: number;
    // FR-SHELL-016: the tree is a linked worktree; the worktree the terminal is linked to, when it asked.
    worktree?: boolean;
    linked?: { path: string; branch?: string; sha?: string; dirty?: boolean; missing?: boolean; inside?: boolean };
};

export type PaneBlockMeta = { view?: string; connection?: string; "cmd:cwd"?: string; "molten:worktree"?: string };

function trimFolder(path: string): string {
    const trimmed = path.replace(/[/\\]+$/, "");
    return trimmed === "" ? path.slice(0, 1) : trimmed;
}

// The folder a block works in: a local terminal's current folder, kept by shell integration in cmd:cwd (the most
// recent cd). A web page, sysinfo, a remote terminal or a terminal that has not reported yet has none.
export function blockFolder(meta: PaneBlockMeta): string {
    if (meta?.view !== "term") {
        return "";
    }
    const connection = meta.connection ?? "";
    if (connection !== "" && connection !== "local") {
        return "";
    }
    const cwd = meta["cmd:cwd"] ?? "";
    return checkAbsolutePath(cwd) ? trimFolder(cwd) : "";
}

export type StatusBarFolder = { folder: string; fromPane: boolean };

// The folder the left side describes: the focused pane's, else the workspace's (FR-SHELL-009), else its project.
export function statusBarFolder(meta: PaneBlockMeta, ws: Workspace): StatusBarFolder {
    const pane = blockFolder(meta);
    if (pane !== "") {
        return { folder: pane, fromPane: true };
    }
    return { folder: effectiveWorkspaceFolder(ws) || readWorkspaceProject(ws).dir, fromPane: false };
}

export type CiVerdictView = { status: string; label: string; iconClass: string };

const CiVerdictLabels: Record<string, string> = {
    success: "CI passed",
    failure: "CI failed",
    running: "CI running",
    missing: "CI not run",
};

// The same marks as the CI/CD panel (ci-local-panel.tsx).
const CiVerdictIcons: Record<string, string> = {
    success: "fa-circle-check text-success",
    failure: "fa-circle-xmark text-error",
    running: "fa-circle-notch fa-spin mt-step-spin text-accent",
    missing: "fa-circle-minus text-muted",
};

export function ciVerdictView(status: string): CiVerdictView {
    return status && CiVerdictLabels[status]
        ? { status, label: CiVerdictLabels[status], iconClass: CiVerdictIcons[status] }
        : null;
}

export type PaneView = {
    folder: string;
    // The workspace's linked project: shown with the workspace's own icon.
    linked: boolean;
    projectName: string;
    projectLogo: string;
    projectTitle: string;
    branch: string;
    branchTitle: string;
    ahead: number;
    dirty: boolean;
    ci: CiVerdictView;
    pr: PaneState["pr"];
};

function shortSha(sha: string): string {
    return (sha ?? "").slice(0, 7);
}

// state is the answer for folder, or null while it is asked (or for a folder of another tree).
export function makePaneView(folder: string, state: PaneState, ws: Workspace): PaneView {
    const linkedDir = readWorkspaceProject(ws).dir;
    const project = state?.project || state?.root || folder;
    const linked =
        linkedDir !== "" && (state?.project ? state.project === linkedDir : checkPathInside(folder, linkedDir));
    const projectName = state?.name || (linked ? pathBaseName(linkedDir) : pathBaseName(project));
    const branch = state?.branch || (state?.detached ? shortSha(state.sha) : "");
    const branchLines: string[] = [];
    if (branch !== "") {
        branchLines.push(state.detached ? `detached at ${shortSha(state.sha)}` : `${branch} at ${shortSha(state.sha)}`);
        if (state.upstream) {
            branchLines.push(`${state.ahead ?? 0} ahead, ${state.behind ?? 0} behind ${state.upstream}`);
        } else if ((state.ahead ?? 0) > 0) {
            branchLines.push(`${state.ahead} commit${state.ahead === 1 ? "" : "s"} on no remote`);
        }
        if (state.dirty) {
            branchLines.push("uncommitted changes");
        }
        branchLines.push("Open the Project tab");
    }
    const ci = ciVerdictView(state?.ci);
    return {
        folder,
        linked,
        projectName,
        projectLogo: state?.logo ?? "",
        projectTitle: [projectName, folder].filter((s) => s).join("\n"),
        branch,
        branchTitle: branchLines.join("\n"),
        ahead: branch !== "" ? (state.ahead ?? 0) : 0,
        dirty: branch !== "" && !!state.dirty,
        ci,
        pr: state?.pr ?? null,
    };
}

// The answer to keep while a new one is asked: one for the same tree still describes the pane (a cd in the tree).
export function keepPaneState(previous: PaneState, folder: string): PaneState {
    if (previous == null || folder === "") {
        return null;
    }
    if (previous.dir === folder || (previous.root && checkPathInside(folder, previous.root))) {
        return previous;
    }
    return null;
}
