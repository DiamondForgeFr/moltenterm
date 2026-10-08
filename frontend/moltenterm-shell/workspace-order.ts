// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rail order (FR-MC-031, DS-MC-024): wavesrv stores it and sorts Wave's workspace list by it
// (pkg/molten/railorder). A move names a neighbour and a side, never an index, so the group rule of FR-MC-027 can be
// checked on the server.

import { TabRpcClient } from "@/app/store/wshrpcutil";

// must match pkg/molten/railorder/order.go
export const RailOrderRoute = "molten:railorder";
export const RailOrderMoveCommand = "railordermove";
const RailOrderCallTimeoutMs = 5000;

export type RailMovePlace = "before" | "after";

export type RailMove = {
    workspaceid: string;
    targetid: string;
    place: RailMovePlace;
    // Moves the whole product the workspace belongs to (FR-MC-027).
    block?: boolean;
};

// Move up (-1) or down (+1) by one place; null at the end it would leave.
export function neighbourMove(ids: string[], id: string, direction: -1 | 1): RailMove {
    const index = ids.indexOf(id);
    if (index < 0) {
        return null;
    }
    const target = ids[index + direction];
    if (target == null) {
        return null;
    }
    return { workspaceid: id, targetid: target, place: direction < 0 ? "before" : "after" };
}

// The move that puts the workspace at slot `slot` among the other workspaces (0 = before all of them); null when it
// would stay where it is.
export function slotMove(ids: string[], id: string, slot: number): RailMove {
    const others = ids.filter((other) => other !== id);
    if (!ids.includes(id) || others.length === 0) {
        return null;
    }
    const at = Math.min(Math.max(slot, 0), others.length);
    if (at === ids.indexOf(id)) {
        return null;
    }
    if (at === 0) {
        return { workspaceid: id, targetid: others[0], place: "before" };
    }
    return { workspaceid: id, targetid: others[at - 1], place: "after" };
}

// The order once the move is applied, as the server applies it; the rail shows it before the server confirms.
export function applyRailMove(ids: string[], move: RailMove): string[] {
    if (move == null || move.workspaceid === move.targetid || !ids.includes(move.workspaceid)) {
        return ids;
    }
    const rtn = ids.filter((id) => id !== move.workspaceid);
    const target = rtn.indexOf(move.targetid);
    if (target < 0) {
        return ids;
    }
    rtn.splice(move.place === "after" ? target + 1 : target, 0, move.workspaceid);
    return rtn;
}

// Sorts any list by the given order of ids; items not in it keep their place after the ordered ones.
export function sortByOrder<T>(items: T[], idOf: (item: T) => string, order: string[]): T[] {
    const rank = new Map(order.map((id, index) => [id, index]));
    return items
        .map((item, index) => ({ item, index, rank: rank.get(idOf(item)) ?? order.length + index }))
        .sort((a, b) => a.rank - b.rank)
        .map((x) => x.item);
}

export async function moveWorkspace(move: RailMove): Promise<string[]> {
    return await TabRpcClient.wshRpcCall(RailOrderMoveCommand, move, {
        route: RailOrderRoute,
        timeout: RailOrderCallTimeoutMs,
    });
}
