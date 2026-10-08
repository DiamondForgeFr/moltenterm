// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Local rail groups (FR-MC-032, DS-MC-028): groups the user makes of any saved workspaces from the rail's link bud,
// its menus or `molten rail group`. wavesrv stores them in the client meta beside the rail order and is their only
// writer (pkg/molten/railorder/localgroups.go); the rail draws them as products (FR-MC-027). This file holds the
// rules the rail applies when it reads them, the same as the server's, so a project group always wins at once.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { RailOrderRoute } from "./workspace-order";

// must match pkg/molten/railorder/localgroups.go
export const RailGroupsMetaKey = "molten:railgroups";
export const LocalKeyPrefix = "local:";
export const MaxGroupNameLength = 64;
export const MinGroupMembers = 2;
export const RailGroupJoinCommand = "railgroupjoin";
export const RailGroupLeaveCommand = "railgroupleave";
export const RailGroupRenameCommand = "railgrouprename";
export const RailGroupUngroupCommand = "railgroupungroup";
const RailGroupCallTimeoutMs = 5000;

export type LocalRailGroup = {
    id: string;
    // Unset: named after its first member, and following that name.
    name?: string;
    // Saved workspace ids, in rail order.
    members: string[];
};

export function readLocalGroups(value: unknown): LocalRailGroup[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const rtn: LocalRailGroup[] = [];
    for (const item of value) {
        if (item == null || typeof item !== "object") {
            continue;
        }
        const raw = item as Record<string, unknown>;
        if (typeof raw.id !== "string" || raw.id === "") {
            continue;
        }
        const members = Array.isArray(raw.members)
            ? raw.members.filter((m): m is string => typeof m === "string" && m !== "")
            : [];
        rtn.push({ id: raw.id, name: typeof raw.name === "string" ? raw.name : "", members });
    }
    return rtn;
}

export function localKey(groupId: string): string {
    return LocalKeyPrefix + groupId;
}

export function isLocalKey(key: string): boolean {
    return key?.startsWith(LocalKeyPrefix) ?? false;
}

// The groups as the rail draws them (railorder Normalize): saved workspaces only, a workspace shown in a project product
// out of its local group, a workspace in its first group only, groups below two members gone, members in rail order.
export function effectiveLocalGroups(
    groups: LocalRailGroup[],
    savedIds: string[],
    productKeys: Map<string, string>
): LocalRailGroup[] {
    const rank = new Map(savedIds.map((id, index) => [id, index]));
    const seen = new Set<string>();
    const ids = new Set<string>();
    const rtn: LocalRailGroup[] = [];
    for (const group of groups ?? []) {
        if (ids.has(group.id)) {
            continue;
        }
        ids.add(group.id);
        const members: string[] = [];
        for (const id of group.members) {
            if (!rank.has(id) || seen.has(id)) {
                continue;
            }
            seen.add(id);
            if (productKeys.has(id)) {
                continue;
            }
            members.push(id);
        }
        if (members.length < MinGroupMembers) {
            continue;
        }
        members.sort((a, b) => rank.get(a) - rank.get(b));
        rtn.push({ id: group.id, name: group.name ?? "", members });
    }
    return rtn;
}

// The name the rail shows: the one the user gave, else its first member's.
export function localGroupName(group: LocalRailGroup, nameOf: (workspaceId: string) => string): string {
    if (group?.name) {
        return group.name;
    }
    return nameOf(group?.members?.[0]) ?? "";
}

export function localGroupOf(groups: LocalRailGroup[], workspaceId: string): LocalRailGroup {
    return groups?.find((g) => g.members.includes(workspaceId)) ?? null;
}

// The rename field's value as the server stores it: trimmed, empty for the default name; null when it is too long.
export function cleanGroupName(name: string): string {
    const trimmed = (name ?? "").trim();
    if ([...trimmed].length > MaxGroupNameLength) {
        return null;
    }
    return trimmed;
}

// What the item's "Group with" menu offers (FR-MC-032-AC10): the other saved workspaces it can be grouped with, in
// rail order, and the local groups it is not in.
export type GroupWithChoice = { id: string; label: string; kind: "workspace" | "group" };

export function groupWithChoices(
    workspaceId: string,
    savedIds: string[],
    productKeys: Map<string, string>,
    groups: LocalRailGroup[],
    nameOf: (workspaceId: string) => string
): GroupWithChoice[] {
    const own = localGroupOf(groups, workspaceId);
    const rtn: GroupWithChoice[] = [];
    for (const group of groups) {
        if (group.id !== own?.id) {
            rtn.push({ id: group.id, label: `${localGroupName(group, nameOf)} (group)`, kind: "group" });
        }
    }
    for (const id of savedIds) {
        if (id === workspaceId || productKeys.has(id) || localGroupOf(groups, id) != null) {
            continue;
        }
        rtn.push({ id, label: nameOf(id) ?? id, kind: "workspace" });
    }
    return rtn;
}

// The refusal of FR-MC-032-AC8, as the server words it.
export function projectGroupRefusal(workspaceName: string, productName: string): string {
    return `${workspaceName} belongs to ${productName}, declared in its project files. Project groups come first.`;
}

export type RailGroupJoin = { workspaceid: string; targetid: string };
export type RailGroupLeave = { workspaceid: string; targetid?: string; place?: "before" | "after" };

async function railGroupCall(command: string, data: unknown): Promise<unknown> {
    return await TabRpcClient.wshRpcCall(command, data, { route: RailOrderRoute, timeout: RailGroupCallTimeoutMs });
}

export async function joinRailGroup(req: RailGroupJoin): Promise<void> {
    await railGroupCall(RailGroupJoinCommand, req);
}

export async function leaveRailGroup(req: RailGroupLeave): Promise<void> {
    await railGroupCall(RailGroupLeaveCommand, req);
}

export async function renameRailGroup(groupId: string, name: string): Promise<void> {
    await railGroupCall(RailGroupRenameCommand, { groupid: groupId, name });
}

export async function ungroupRailGroup(groupId: string): Promise<void> {
    await railGroupCall(RailGroupUngroupCommand, { groupid: groupId });
}
