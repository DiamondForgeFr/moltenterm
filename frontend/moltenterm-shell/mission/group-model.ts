// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Project groups (FR-MC-026, DS-MC-017): wavesrv resolves them from the workspace links and each member's
// `.molten/project.json`, with a state summary per member. The rail (FR-MC-027) and the group strip (FR-MC-028) read
// them with missionGroups and follow MissionGroupsEvent; these helpers hold the rules they share.

// must match the names in pkg/molten/mission/group.go
export const MissionGroupsCommand = "moltenmissiongroups";
export const MissionGroupsEvent = "molten:mission:groups";

// red (a CI or a build failed) over amber (a stale dependency) over none; a running job gives none.
export type GroupWorst = "" | "red" | "amber";

// must match GroupMemberState in pkg/molten/mission/group.go
export type GroupMemberState = {
    missing?: boolean;
    // 0 when Mission Control never read the member (its workspace was never opened).
    collectedat?: number;
    trunk?: string;
    trunksha?: string;
    trunkci?: string;
    remoteci?: string;
    remoteciurl?: string;
    build?: string;
    buildid?: string;
    buildat?: number;
    releasetag?: string;
    lasttag?: string;
    worst?: GroupWorst;
};

// must match GroupMemberInfo in pkg/molten/mission/group.go
export type GroupMember = {
    dir: string;
    name: string;
    // The group name as this member wrote it.
    group: string;
    // In rail order; the first one is where the member opens.
    workspaces: { id: string; name?: string }[];
    state: GroupMemberState;
};

// must match GroupInfo in pkg/molten/mission/group.go
export type ProjectGroup = {
    // Trimmed and lowercased: client state (a collapsed product) is keyed by it, never by the spelling.
    key: string;
    // The first member's spelling in rail order.
    name: string;
    members: GroupMember[];
    worst?: GroupWorst;
};

export type GroupsAnswer = { groups: ProjectGroup[] };

// A group of one linked member shows as an ordinary workspace, with no product entry (FR-MC-027).
export function isProductGroup(group: ProjectGroup): boolean {
    return (group?.members?.length ?? 0) >= 2;
}

// The group a workspace's project belongs to, when it is a product of two members or more.
export function productGroupOfWorkspace(groups: ProjectGroup[], workspaceId: string): ProjectGroup {
    if (!workspaceId) {
        return null;
    }
    for (const group of groups ?? []) {
        if (!isProductGroup(group)) {
            continue;
        }
        if (group.members.some((m) => m.workspaces?.some((ws) => ws.id === workspaceId))) {
            return group;
        }
    }
    return null;
}

// The member a project folder is, in its group.
export function groupMemberOf(group: ProjectGroup, dir: string): GroupMember {
    if (!dir) {
        return null;
    }
    return group?.members?.find((m) => m.dir === dir) ?? null;
}
