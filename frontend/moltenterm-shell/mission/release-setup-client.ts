// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release setup's calls to wavesrv (FR-MC-036): the draft and the agent's proposal write nothing; the write is the
// developer's click on the reviewed diff, and opens a pull request (#1098).

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MissionRouteId } from "./mission-client";
import type {
    SetupCheck,
    SetupDraft,
    SetupKind,
    SetupOptions,
    SetupPrJob,
    SetupPrRequest,
    SetupRefined,
    SetupTicket,
} from "./release-setup-model";

// must match the names in pkg/molten/mission/collector.go
export const MissionSetupDraftCommand = "moltenmissionsetupdraft";
export const MissionSetupRefineCommand = "moltenmissionsetuprefine";
export const MissionSetupWriteCommand = "moltenmissionsetupwrite";
export const MissionSetupCheckCommand = "moltenmissionsetupcheck";
export const MissionSetupUpdateCommand = "moltenmissionsetupupdate";
export const MissionSetupPrStateCommand = "moltenmissionsetupprstate";
export const MissionSetupTicketsCommand = "moltenmissionsetuptickets";

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

export function setupRefine(dir: string, text: string, includeLocal?: boolean): Promise<SetupRefined> {
    return setupCall(
        MissionSetupRefineCommand,
        { dir, text, includelocal: includeLocal || undefined },
        SetupRefineTimeoutMs
    );
}

// Starts the pull request of the reviewed text (#1098); setupPrState follows it.
export function setupWrite(
    dir: string,
    text: string,
    base: string,
    generated: Record<string, string>,
    pr: SetupPrRequest
): Promise<SetupPrJob> {
    return setupCall(MissionSetupWriteCommand, { dir, text, base, generated, ...pr }, SetupWriteTimeoutMs);
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

export function setupTickets(dir: string): Promise<{ tickets: SetupTicket[] }> {
    return setupCall(MissionSetupTicketsCommand, { dir }, SetupDraftTimeoutMs);
}
