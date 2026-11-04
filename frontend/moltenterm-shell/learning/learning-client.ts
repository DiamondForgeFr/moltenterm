// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The windows' calls to the learning store (FR-LRN-002): wavesrv's route molten:learning, the same one `molten learn`
// reaches. A view reads the defaults when its workflow starts and records the adjustments of a run when it ends.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    emptyDefaults,
    LearnAction,
    LearningDefaults,
    LearningDefaultsCommand,
    LearningEditCommand,
    LearningForgetCommand,
    LearningItem,
    LearningList,
    LearningListCommand,
    LearningRecordCommand,
    LearningResetCommand,
    LearningRoute,
} from "./learning-model";

const LearningTimeoutMs = 5000;

function learningCall<T>(command: string, data: Record<string, unknown>): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: LearningRoute, timeout: LearningTimeoutMs });
}

export async function learningDefaults(workflow: string): Promise<LearningDefaults> {
    const defaults = await learningCall<LearningDefaults>(LearningDefaultsCommand, { workflow });
    return {
        ...emptyDefaults(workflow),
        ...defaults,
        prefill: defaults?.prefill ?? [],
        folded: defaults?.folded ?? [],
    };
}

export async function learningList(workflow?: string): Promise<LearningList> {
    const list = await learningCall<LearningList>(LearningListCommand, workflow ? { workflow } : {});
    return { workflows: (list?.workflows ?? []).map((w) => ({ ...w, items: w.items ?? [] })) };
}

export function learningEdit(workflow: string, id: string, value: string): Promise<LearningItem> {
    return learningCall(LearningEditCommand, { workflow, id, value });
}

export function learningForget(workflow: string, id: string): Promise<unknown> {
    return learningCall(LearningForgetCommand, { workflow, id });
}

export function learningReset(workflow: string): Promise<{ forgotten: number }> {
    return learningCall(LearningResetCommand, { workflow });
}

// Records an adjustment of a run; the run label is what the list shows as the source.
export function learningRecord(
    workflow: string,
    kind: string,
    key: string,
    fields: { value?: string; proposed?: string; run?: string } = {}
): Promise<unknown> {
    return learningCall(LearningRecordCommand, {
        workflow,
        kind,
        key,
        value: fields.value || undefined,
        proposed: fields.proposed || undefined,
        run: fields.run || undefined,
    });
}

// Records what a finished run taught (correctionsToLearn). A failure is never the developer's problem: learning is a
// convenience, the workflow already did its job.
export async function learnFromRun(workflow: string, actions: LearnAction[], run: string): Promise<void> {
    for (const action of actions) {
        try {
            if (action.op === "forget") {
                await learningForget(workflow, action.id);
                continue;
            }
            await learningRecord(workflow, action.kind, action.key, {
                value: action.value,
                proposed: action.proposed,
                run,
            });
        } catch (e) {
            console.log("learning: not recorded", workflow, action, e);
        }
    }
}
