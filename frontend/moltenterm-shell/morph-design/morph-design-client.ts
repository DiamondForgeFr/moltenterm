// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's calls to the design (FR-MORPH-019): wavesrv's route molten:morphdesign, the one `molten morph design`
// reaches. The panel only reads the design and relays the developer's decisions; the agent's commands are the
// terminals'.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { learningRecord } from "../learning/learning-client";
import { KindAnswer, KindDone, KindSkip, WorkflowMorphDesign } from "../learning/learning-model";
import {
    MorphDesign,
    MorphDesignChooseCommand,
    MorphDesignDecideCommand,
    MorphDesignRoute,
    MorphDesignSkipCommand,
    MorphDesignStateCommand,
    MorphDesignTabCommand,
    MorphStepId,
    readMorphDesign,
} from "./morph-design-model";

const CallTimeoutMs = 15000;
// The agent's prompt may be busy: wavesrv waits for it a moment before it queues the message.
const ClickTimeoutMs = 30000;

function call<T>(command: string, data: Record<string, unknown>, timeout = CallTimeoutMs): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MorphDesignRoute, timeout });
}

export async function morphDesignState(mod: string): Promise<MorphDesign> {
    return readMorphDesign(await call(MorphDesignStateCommand, { mod }));
}

export type MorphTabResult = { tabid: string; created?: boolean };

export function morphDesignTab(data: {
    mod: string;
    workspaceid: string;
    handoffid: string;
    tabname: string;
}): Promise<MorphTabResult> {
    return call(MorphDesignTabCommand, data);
}

export async function morphDesignChoose(mod: string, key: string, label: string): Promise<MorphDesign> {
    return readMorphDesign(await call(MorphDesignChooseCommand, { mod, key, value: label }, ClickTimeoutMs));
}

export type StepGesture = "skip" | "unskip" | "terminal";

export async function morphDesignSkip(mod: string, step: MorphStepId, action: StepGesture): Promise<MorphDesign> {
    return readMorphDesign(await call(MorphDesignSkipCommand, { mod, step, action }, ClickTimeoutMs));
}

export type Decision = "agree" | "validate" | "giveup";

export async function morphDesignDecide(mod: string, action: Decision): Promise<MorphDesign> {
    return readMorphDesign(await call(MorphDesignDecideCommand, { mod, action }, ClickTimeoutMs));
}

// What the developer decided in the view goes to the workflow's memory (#1879) as it happens: an answer they clicked,
// a step they skipped, a step they did. A memory that cannot take it is never the developer's problem.
async function remember(kind: string, key: string, mod: string, value?: string) {
    try {
        await learningRecord(WorkflowMorphDesign, kind, key, { value, run: mod });
    } catch (e) {
        console.log("morph design: not remembered", kind, key, e);
    }
}

export function rememberAnswer(mod: string, key: string, label: string) {
    return remember(KindAnswer, key, mod, label);
}

export function rememberSkip(mod: string, step: MorphStepId) {
    return remember(KindSkip, step, mod);
}

export function rememberDone(mod: string, step: MorphStepId) {
    return remember(KindDone, step, mod);
}
