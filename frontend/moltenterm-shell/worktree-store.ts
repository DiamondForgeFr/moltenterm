// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The link between a terminal and its worktree lives in the block's meta (DS-SHELL-016); the plan and the removal are
// asked of wavesrv, which re-reads the plan before removing anything.

import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MissionRouteId } from "./mission/mission-client";
import {
    WorktreeDismissedMetaKey,
    WorktreeMetaKey,
    WorktreePlan,
    WorktreeRemoveResult,
    WorktreeRisk,
    withWorktreeDismissed,
} from "./worktree-model";

// must match WorktreePlanCommand and WorktreeRemoveCommand in pkg/molten/mission/worktree.go
export const MissionWorktreePlanCommand = "moltenmissionworktreeplan";
export const MissionWorktreeRemoveCommand = "moltenmissionworktreeremove";

const PlanTimeoutMs = 65000;

async function setBlockMeta(blockId: string, meta: Record<string, any>): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("block", blockId), meta: meta as MetaType });
}

export async function linkWorktree(blockId: string, path: string): Promise<void> {
    await setBlockMeta(blockId, { [WorktreeMetaKey]: path });
}

export async function unlinkWorktree(blockId: string): Promise<void> {
    await setBlockMeta(blockId, { [WorktreeMetaKey]: null });
}

export async function dismissWorktree(blockId: string, dismissed: readonly string[], path: string): Promise<void> {
    await setBlockMeta(blockId, { [WorktreeDismissedMetaKey]: withWorktreeDismissed(dismissed, path) });
}

export function worktreePlan(dir: string, blockId: string): Promise<WorktreePlan> {
    return TabRpcClient.wshRpcCall(
        MissionWorktreePlanCommand,
        { dir, blockid: blockId },
        { route: MissionRouteId, timeout: PlanTimeoutMs }
    );
}

export function removeWorktree(
    dir: string,
    blockId: string,
    // confirmed: the plan the user confirmed a second time; null when nothing was at risk.
    opts: { confirmed: WorktreeRisk; deleteBranch: boolean }
): Promise<WorktreeRemoveResult> {
    return TabRpcClient.wshRpcCall(
        MissionWorktreeRemoveCommand,
        { dir, blockid: blockId, confirmed: opts.confirmed ?? undefined, deletebranch: opts.deleteBranch },
        { route: MissionRouteId, timeout: PlanTimeoutMs }
    );
}
