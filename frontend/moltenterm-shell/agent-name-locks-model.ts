// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// First names locked for a project (FR-CONT-014, DS-CONT-028, #2324): wavesrv reserves a name for a project's folder,
// and a new agent started in that project gets it back. The windows lock and unlock from an agent's Connections, show a
// lock beside a locked name and list a project's locked names in its sheet. Kept apart from the components so the rules
// can be tested without the app.

import type { AgentStateInfo } from "./agent-state-model";
import { t } from "./i18n/i18n";
import { projectLabel, projectRepoDir, type WorkspaceProjectEntry } from "./sidebar/workspace-projects";
import { pathBaseName } from "./workspace-project";

// must match pkg/molten/agentnamelocks.go
export const AgentNameLocksCommand = "moltenagentnamelocks";
export const AgentNameLockCommand = "moltenagentnamelock";
export const AgentNameUnlockCommand = "moltenagentnameunlock";
export const AgentNameLocksEvent = "molten:agentnamelocks";

// must match AgentNameLock in pkg/molten/agentnamelocks.go: project is the project's folder.
export type AgentNameLock = { name: string; project: string };

export type AgentNameLockStatus =
    | "locked"
    | "already"
    | "elsewhere"
    | "noagent"
    | "noproject"
    | "notlockable"
    | "failed";

// must match AgentNameLockResult in pkg/molten/agentnamelocks.go
export type AgentNameLockResult = { status: AgentNameLockStatus; name?: string; project?: string; from?: string };

export type AgentNameUnlockStatus = "unlocked" | "none" | "failed";

export type AgentNameUnlockResult = { status: AgentNameUnlockStatus; name?: string };

function normalFolder(folder: string): string {
    return (folder ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sameProjectFolder(a: string, b: string): boolean {
    const folder = normalFolder(a);
    return folder !== "" && folder === normalFolder(b);
}

// What a project is called where a lock names it: the label of the workspace's project whose folder, or repository, it
// is, else its folder's name.
export function lockProjectLabel(folder: string, projects: WorkspaceProjectEntry[]): string {
    const project = (projects ?? []).find(
        (p) => sameProjectFolder(p.dir, folder) || sameProjectFolder(projectRepoDir(p), folder)
    );
    return project != null ? projectLabel(project) : pathBaseName(folder);
}

// A project's locked names in the order they were locked, which is the order a new agent takes them in.
export function locksOfProject(locks: AgentNameLock[], folder: string): AgentNameLock[] {
    return (locks ?? []).filter((l) => sameProjectFolder(l.project, folder));
}

export type NameAction =
    | { kind: "none" }
    | { kind: "lock"; name: string; project: string; lockedFor: string }
    | { kind: "unlock"; name: string; project: string };

// What an agent's Connections offer on its first name: Unlock when the name is locked for the agent's project (or the
// agent has none), Lock for the agent's project otherwise, which asks first when another project holds the name.
export function nameAction(info: AgentStateInfo): NameAction {
    const name = (info?.firstname ?? "").trim();
    if (name === "") {
        return { kind: "none" };
    }
    const lockedFor = info.namelockedfor ?? "";
    const project = info.project ?? "";
    if (lockedFor !== "" && (project === "" || sameProjectFolder(lockedFor, project))) {
        return { kind: "unlock", name, project: lockedFor };
    }
    if (project === "") {
        return { kind: "none" };
    }
    return { kind: "lock", name, project, lockedFor };
}

// A name locked for another project moves only on the developer's answer (FR-CONT-014 AC): Lock asks first then.
export function asksToMove(action: NameAction): boolean {
    return action.kind === "lock" && action.lockedFor !== "";
}

// The sentence a lock that did not happen says; "" when it did, or needs the move question first.
export function lockFailureText(result: AgentNameLockResult, name: string): string {
    switch (result?.status) {
        case "locked":
        case "already":
        case "elsewhere":
            return "";
        case "noagent":
            return t("agentNames.error.noAgent");
        case "noproject":
            return t("agentNames.error.noProject", { name });
        case "notlockable":
            return t("agentNames.error.notLockable", { name });
    }
    return t("agentNames.error.failed");
}

export function unlockFailureText(result: AgentNameUnlockResult, name: string): string {
    return result?.status === "failed" ? t("agentNames.error.unlockFailed", { name }) : "";
}
