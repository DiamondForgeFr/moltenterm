// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The link between a terminal and its worktree lives in the block's meta (DS-SHELL-016); the plan and the removal are
// asked of wavesrv, which re-reads the plan before removing anything.

import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MissionRouteId } from "./mission/mission-client";
import { resolveMoltentermNotification } from "./notifications-store";
import {
    keptWorktreeNoticeKey,
    withWorktreeDismissed,
    WorktreeDismissedMetaKey,
    WorktreeMetaKey,
    WorktreePlan,
    WorktreeRemoveResult,
    WorktreeRisk,
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

// blockId: the terminal being closed ("" when none is, a notification's review); blockIds: every terminal closed with
// it (a whole tab). None of them counts among the worktree's other terminals.
export function worktreePlan(dir: string, blockId: string, blockIds?: string[]): Promise<WorktreePlan> {
    return TabRpcClient.wshRpcCall(
        MissionWorktreePlanCommand,
        { dir, blockid: blockId || undefined, blockids: blockIds },
        { route: MissionRouteId, timeout: PlanTimeoutMs }
    );
}

export async function removeWorktree(
    dir: string,
    blockId: string,
    // confirmed: the plan the user confirmed a second time; null when nothing was at risk.
    opts: { confirmed: WorktreeRisk; deleteBranch: boolean; blockIds?: string[] }
): Promise<WorktreeRemoveResult> {
    const result: WorktreeRemoveResult = await TabRpcClient.wshRpcCall(
        MissionWorktreeRemoveCommand,
        {
            dir,
            blockid: blockId || undefined,
            blockids: opts.blockIds,
            confirmed: opts.confirmed ?? undefined,
            deletebranch: opts.deleteBranch,
        },
        { route: MissionRouteId, timeout: PlanTimeoutMs }
    );
    resolveKeptWorktreeNotice(dir, result?.real);
    return result;
}

// The worktree is gone: a notification saying it is still on disk is answered.
// wavesrv keys its notices by the canonical path (real); a window may know the worktree by another one.
export function resolveKeptWorktreeNotice(dir: string, real?: string): void {
    resolveMoltentermNotification(keptWorktreeNoticeKey(dir));
    if (real && real !== dir) {
        resolveMoltentermNotification(keptWorktreeNoticeKey(real));
    }
}
