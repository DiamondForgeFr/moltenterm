// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release setup's calls to wavesrv (FR-MC-036): the draft and the agent's proposal write nothing; the write is the
// developer's click on the reviewed diff.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MissionRouteId } from "./mission-client";
import type { SetupDraft, SetupKind, SetupOptions, SetupRefined } from "./release-setup-model";

// must match the names in pkg/molten/mission/collector.go
export const MissionSetupDraftCommand = "moltenmissionsetupdraft";
export const MissionSetupRefineCommand = "moltenmissionsetuprefine";
export const MissionSetupWriteCommand = "moltenmissionsetupwrite";

const SetupDraftTimeoutMs = 90000;
// The coding agent reads the repository: the backend stops it at 10 minutes.
const SetupRefineTimeoutMs = 11 * 60 * 1000;
const SetupWriteTimeoutMs = 15000;

function setupCall<T>(command: string, data: any, timeout: number): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MissionRouteId, timeout });
}

// options null: the provider's own draft (SaaSFoundryAI's when it offers one), for the kind confirmed.
export function setupDraft(dir: string, options: SetupOptions, kind?: SetupKind): Promise<SetupDraft> {
    return setupCall(MissionSetupDraftCommand, { dir, options: options ?? undefined, kind }, SetupDraftTimeoutMs);
}

export function setupRefine(dir: string, text: string): Promise<SetupRefined> {
    return setupCall(MissionSetupRefineCommand, { dir, text }, SetupRefineTimeoutMs);
}

export function setupWrite(dir: string, text: string, base: string): Promise<{ path: string; warnings: string[] }> {
    return setupCall(MissionSetupWriteCommand, { dir, text, base }, SetupWriteTimeoutMs);
}
