// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Product groups in the workspace rail (FR-MC-027, DS-MC-018): a group of two members or more is one collapsible
// product entry, its workspaces indented below it. The rail order stays one flat list of workspace ids (FR-MC-031); the
// rail reads it as units: a product sits where its first workspace sits, its workspaces following in their rail order.
// The move rules mirror pkg/molten/railorder (MoveGrouped), which refuses any other move.

import { GroupMember, GroupMemberState, isProductGroup, ProjectGroup } from "./mission/group-model";
import { RailMove } from "./workspace-order";
import { WorkspaceRailEntry } from "./workspace-rail-model";

// The products the user collapsed, by group key, in the client meta: this machine only, never in a project.
export const RailCollapsedMetaKey = "molten:railcollapsed";
export const ProductUnitPrefix = "product:";

export type RailWorkspaceUnit = { kind: "workspace"; id: string; entry: WorkspaceRailEntry };
export type RailProductUnit = {
    kind: "product";
    // ProductUnitPrefix + the group key.
    id: string;
    key: string;
    group: ProjectGroup;
    // Its workspaces, in rail order.
    entries: WorkspaceRailEntry[];
};
export type RailUnit = RailWorkspaceUnit | RailProductUnit;

export type UnitMoves = { up: RailMove; down: RailMove };

// workspace id → key of its product, for the groups of two members or more.
export function productKeysOf(groups: ProjectGroup[]): Map<string, string> {
    const rtn = new Map<string, string>();
    for (const group of groups ?? []) {
        if (!isProductGroup(group)) {
            continue;
        }
        for (const member of group.members) {
            for (const ws of member.workspaces ?? []) {
                rtn.set(ws.id, group.key);
            }
        }
    }
    return rtn;
}

// The units of the rail. An unsaved workspace is never part of a product: it cannot move, and it is not linked yet.
export function makeRailUnits(entries: WorkspaceRailEntry[], groups: ProjectGroup[]): RailUnit[] {
    const keys = productKeysOf(groups);
    const byKey = new Map<string, ProjectGroup>();
    for (const group of groups ?? []) {
        byKey.set(group.key, group);
    }
    const units: RailUnit[] = [];
    const products = new Map<string, RailProductUnit>();
    for (const entry of entries ?? []) {
        const key = entry.saved ? keys.get(entry.id) : null;
        if (key == null) {
            units.push({ kind: "workspace", id: entry.id, entry });
            continue;
        }
        let unit = products.get(key);
        if (unit == null) {
            unit = { kind: "product", id: ProductUnitPrefix + key, key, group: byKey.get(key), entries: [] };
            products.set(key, unit);
            units.push(unit);
        }
        unit.entries.push(entry);
    }
    return units;
}

function isMovableUnit(unit: RailUnit): boolean {
    return unit.kind === "product" || unit.entry.saved;
}

function firstIdOf(unit: RailUnit): string {
    return unit.kind === "product" ? unit.entries[0]?.id : unit.id;
}

function lastIdOf(unit: RailUnit): string {
    return unit.kind === "product" ? unit.entries[unit.entries.length - 1]?.id : unit.id;
}

function unitMove(unit: RailUnit, targetId: string, place: "before" | "after"): RailMove {
    if (unit.kind === "product") {
        return { workspaceid: firstIdOf(unit), targetid: targetId, place, block: true };
    }
    return { workspaceid: unit.id, targetid: targetId, place };
}

// Move up / down of a unit: past the whole unit next to it, a product moving as a block.
export function unitMoves(units: RailUnit[], unitId: string): UnitMoves {
    const movable = units.filter(isMovableUnit);
    const index = movable.findIndex((u) => u.id === unitId);
    if (index < 0) {
        return { up: null, down: null };
    }
    const unit = movable[index];
    const above = movable[index - 1];
    const below = movable[index + 1];
    return {
        up: above == null ? null : unitMove(unit, firstIdOf(above), "before"),
        down: below == null ? null : unitMove(unit, lastIdOf(below), "after"),
    };
}

// Move up / down of a product's workspace: within its product only (FR-MC-027-AC1).
export function memberMoves(product: RailProductUnit, workspaceId: string): UnitMoves {
    const ids = product.entries.map((e) => e.id);
    const index = ids.indexOf(workspaceId);
    if (index < 0) {
        return { up: null, down: null };
    }
    return {
        up: index > 0 ? { workspaceid: workspaceId, targetid: ids[index - 1], place: "before" } : null,
        down: index < ids.length - 1 ? { workspaceid: workspaceId, targetid: ids[index + 1], place: "after" } : null,
    };
}

// The move that drops a unit at slot `slot` among the other movable units (0 = before all of them); null when it would
// stay where it is.
export function unitSlotMove(units: RailUnit[], unitId: string, slot: number): RailMove {
    const movable = units.filter(isMovableUnit);
    const index = movable.findIndex((u) => u.id === unitId);
    const others = movable.filter((u) => u.id !== unitId);
    if (index < 0 || others.length === 0) {
        return null;
    }
    const at = Math.min(Math.max(slot, 0), others.length);
    if (at === index) {
        return null;
    }
    const unit = movable[index];
    if (at === 0) {
        return unitMove(unit, firstIdOf(others[0]), "before");
    }
    return unitMove(unit, lastIdOf(others[at - 1]), "after");
}

// Each product's workspaces gathered where its first one sits (railorder.Normalize).
export function normalizeOrder(ids: string[], keys: Map<string, string>): string[] {
    const rtn: string[] = [];
    const gathered = new Set<string>();
    for (const id of ids) {
        const key = keys.get(id);
        if (key == null) {
            rtn.push(id);
            continue;
        }
        if (gathered.has(key)) {
            continue;
        }
        gathered.add(key);
        rtn.push(...ids.filter((other) => keys.get(other) === key));
    }
    return rtn;
}

function insertAt(ids: string[], move: RailMove, moved: string[]): string[] {
    const at = ids.indexOf(move.targetid);
    if (at < 0) {
        return null;
    }
    const rtn = [...ids];
    rtn.splice(move.place === "after" ? at + 1 : at, 0, ...moved);
    return rtn;
}

// The order once the move is applied, as the server applies it, so the rail shows it before the server confirms; the
// ids unchanged when the server would refuse it.
export function applyGroupedMove(ids: string[], keys: Map<string, string>, move: RailMove): string[] {
    if (move == null || move.workspaceid === move.targetid || !ids.includes(move.workspaceid)) {
        return ids;
    }
    const normal = normalizeOrder(ids, keys);
    const own = keys.get(move.workspaceid);
    const target = keys.get(move.targetid);
    if (move.block) {
        if (own == null || own === target || !landsOnEdge(normal, keys, move)) {
            return ids;
        }
        const block = normal.filter((id) => keys.get(id) === own);
        return (
            insertAt(
                normal.filter((id) => keys.get(id) !== own),
                move,
                block
            ) ?? ids
        );
    }
    if (own != null ? own !== target : !landsOnEdge(normal, keys, move)) {
        return ids;
    }
    return (
        insertAt(
            normal.filter((id) => id !== move.workspaceid),
            move,
            [move.workspaceid]
        ) ?? ids
    );
}

function landsOnEdge(normal: string[], keys: Map<string, string>, move: RailMove): boolean {
    const key = keys.get(move.targetid);
    if (key == null) {
        return true;
    }
    const span = normal.filter((id) => keys.get(id) === key);
    return move.place === "before" ? span[0] === move.targetid : span[span.length - 1] === move.targetid;
}

function sameName(a: string, b: string): boolean {
    const x = (a ?? "").trim().toLowerCase();
    return x !== "" && x === (b ?? "").trim().toLowerCase();
}

// The member a workspace of the product is linked to.
export function memberOfWorkspace(group: ProjectGroup, workspaceId: string): GroupMember {
    return group?.members?.find((m) => m.workspaces?.some((ws) => ws.id === workspaceId)) ?? null;
}

// The workspace whose icon the product shows (FR-MC-027-AC7): the member whose project is named like the group, else
// the first member in rail order.
export function productIconEntry(unit: RailProductUnit): WorkspaceRailEntry {
    const named = unit.group?.members?.find((m) => sameName(m.name, unit.group.name));
    if (named != null) {
        const entry = unit.entries.find((e) => named.workspaces?.some((ws) => ws.id === e.id));
        if (entry != null) {
            return entry;
        }
    }
    return unit.entries[0];
}

// What a member's state says on hover, from the collector's summary (DS-MC-017).
export function memberStateText(state: GroupMemberState): string {
    if (state == null) {
        return "no state yet";
    }
    if (state.missing) {
        return "folder missing";
    }
    const trunk = state.trunk || "the trunk";
    const parts: string[] = [];
    if (state.trunkci === "failure") {
        parts.push(`local CI failed on ${trunk}`);
    }
    if (state.remoteci === "failure") {
        parts.push(`GitHub CI failed on ${trunk}`);
    }
    if (state.build === "failure") {
        parts.push("last build failed");
    }
    for (const dep of state.deps ?? []) {
        if (dep.state === "stale") {
            parts.push(`stale dependency on ${dep.sourcename || dep.project}`);
        } else if (dep.state === "uncommitted") {
            parts.push(`${dep.sourcename || dep.project} synced, not committed`);
        }
    }
    if (parts.length > 0) {
        return parts.join(", ");
    }
    if (state.trunkci === "running" || state.remoteci === "running" || state.build === "running") {
        return "running";
    }
    if (!state.collectedat && !state.trunkci && !state.remoteci && !state.build) {
        return "not read yet";
    }
    return "OK";
}

export function worstLabel(worst: string): string {
    if (worst === "red") {
        return "CI or build failed";
    }
    if (worst === "amber") {
        return "stale dependency";
    }
    return "";
}

// The product's hover: its name, then each workspace with its member's state.
export function productHoverText(unit: RailProductUnit): string {
    const lines = [unit.group?.name || unit.key];
    for (const entry of unit.entries) {
        lines.push(`${entry.name}: ${memberStateText(memberOfWorkspace(unit.group, entry.id)?.state)}`);
    }
    return lines.join("\n");
}

export function readCollapsed(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((key): key is string => typeof key === "string" && key !== "");
}

export function withCollapsed(value: unknown, key: string, collapsed: boolean): string[] {
    const keys = readCollapsed(value).filter((k) => k !== key);
    if (collapsed) {
        keys.push(key);
    }
    return keys;
}
