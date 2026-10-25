// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release setup's calls to wavesrv (FR-MC-036): the draft and the agent's proposal write nothing; the write is the
// developer's click on the reviewed diff, and opens a pull request (#1098). The agent proposes step changes, never a
// file (#1099, FR-MC-039).

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MissionRouteId } from "./mission-client";
import type { SetupModel } from "./release-setup-describe-model";
import type {
    SetupApplied,
    SetupCheck,
    SetupDraft,
    SetupKind,
    SetupOptions,
    SetupPrJob,
    SetupPrRequest,
    SetupProposedFile,
    SetupRefined,
    SetupStepChange,
    SetupTicket,
} from "./release-setup-model";
import type { SetupPrStatus } from "./release-setup-prepared-model";
import type { SetupAnswers, SetupSurvey } from "./release-setup-stepper";

// must match the names in pkg/molten/mission/collector.go
export const MissionSetupDraftCommand = "moltenmissionsetupdraft";
export const MissionSetupRefineCommand = "moltenmissionsetuprefine";
export const MissionSetupApplyCommand = "moltenmissionsetupapply";
export const MissionSetupPromptCommand = "moltenmissionsetupprompt";
export const MissionSetupWriteCommand = "moltenmissionsetupwrite";
export const MissionSetupCheckCommand = "moltenmissionsetupcheck";
export const MissionSetupUpdateCommand = "moltenmissionsetupupdate";
export const MissionSetupPrStateCommand = "moltenmissionsetupprstate";
export const MissionSetupTicketsCommand = "moltenmissionsetuptickets";
export const MissionSetupSurveyCommand = "moltenmissionsetupsurvey";
export const MissionSetupAnswersCommand = "moltenmissionsetupanswers";
export const MissionSetupModelsCommand = "moltenmissionsetupmodels";
export const MissionSetupPrStatusCommand = "moltenmissionsetupprstatus";

const SetupDraftTimeoutMs = 90000;
// The coding agent reads the repository: the backend stops it at 10 minutes.
const SetupRefineTimeoutMs = 11 * 60 * 1000;
const SetupWriteTimeoutMs = 15000;

function setupCall<T>(command: string, data: any, timeout: number): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MissionRouteId, timeout });
}

// options null: the provider's own draft (SaaSFoundryAI's when it offers one), for the kind confirmed. includeLocal:
// built on the working copy's uncommitted pipeline instead of the committed one (#1098).
export function setupDraft(
    dir: string,
    options: SetupOptions,
    kind?: SetupKind,
    includeLocal?: boolean
): Promise<SetupDraft> {
    return setupCall(
        MissionSetupDraftCommand,
        { dir, options: options ?? undefined, kind, includelocal: includeLocal || undefined },
        SetupDraftTimeoutMs
    );
}

// The agent's step changes on the draft (#1099): request is the developer's words; answer, one pasted from another
// agent (then nothing runs).
export function setupRefine(dir: string, text: string, request?: string, answer?: string): Promise<SetupRefined> {
    return setupCall(
        MissionSetupRefineCommand,
        { dir, text, request: request || undefined, answer: answer || undefined },
        SetupRefineTimeoutMs
    );
}

export function setupApply(
    dir: string,
    text: string,
    changes: SetupStepChange[],
    chosen: string[]
): Promise<SetupApplied> {
    return setupCall(MissionSetupApplyCommand, { dir, text, changes, chosen }, SetupDraftTimeoutMs);
}

// The request any agentic CLI can answer, for the developer to run in the agent of their choice.
export function setupPrompt(dir: string, text: string, request?: string): Promise<{ prompt: string }> {
    return setupCall(MissionSetupPromptCommand, { dir, text, request: request || undefined }, SetupWriteTimeoutMs);
}

// Starts the pull request of the reviewed text (#1098); setupPrState follows it.
export function setupWrite(
    dir: string,
    text: string,
    base: string,
    generated: Record<string, string>,
    pr: SetupPrRequest,
    files?: SetupProposedFile[]
): Promise<SetupPrJob> {
    return setupCall(
        MissionSetupWriteCommand,
        { dir, text, base, generated, files: files?.length ? files : undefined, ...pr },
        SetupWriteTimeoutMs
    );
}

// Step 2b's "another project as a model" (FR-MC-041): the linked projects' committed pipelines, adapted to this one.
export function setupModels(dir: string): Promise<{ models: SetupModel[] }> {
    return setupCall(MissionSetupModelsCommand, { dir }, SetupDraftTimeoutMs);
}

// Compares the release setup with what this version of MoltenTerm writes (#1086); the remote facts are read again.
export function setupCheck(
    dir: string,
    choices?: Record<string, boolean>,
    includeLocal?: boolean
): Promise<SetupCheck> {
    return setupCall(
        MissionSetupCheckCommand,
        { dir, choices, includelocal: includeLocal || undefined },
        SetupDraftTimeoutMs
    );
}

export function setupUpdate(
    dir: string,
    base: string,
    signature: string,
    choices: Record<string, boolean>,
    pr: SetupPrRequest
): Promise<SetupPrJob> {
    return setupCall(MissionSetupUpdateCommand, { dir, base, signature, choices, ...pr }, SetupWriteTimeoutMs);
}

export function setupPrState(id: string): Promise<SetupPrJob> {
    return setupCall(MissionSetupPrStateCommand, { id }, SetupWriteTimeoutMs);
}

// Step 1 of the stepper (FR-MC-038): the app type, what the repository shows of a pipeline, and the saved answers.
export function setupSurvey(dir: string): Promise<SetupSurvey> {
    return setupCall(MissionSetupSurveyCommand, { dir }, SetupDraftTimeoutMs);
}

// Keeps the stepper's answers for the project in MoltenTerm's data; null forgets them.
export function setupSaveAnswers(dir: string, answers: SetupAnswers): Promise<{ saved: boolean }> {
    return setupCall(MissionSetupAnswersCommand, { dir, answers: answers ?? undefined }, SetupWriteTimeoutMs);
}

// The pull request the setup opened, as GitHub has it now (#1104): read only.
export function setupPrStatus(dir: string, number: number): Promise<SetupPrStatus> {
    return setupCall(MissionSetupPrStatusCommand, { dir, number }, SetupDraftTimeoutMs);
}

export function setupTickets(dir: string): Promise<{ tickets: SetupTicket[] }> {
    return setupCall(MissionSetupTicketsCommand, { dir }, SetupDraftTimeoutMs);
}
