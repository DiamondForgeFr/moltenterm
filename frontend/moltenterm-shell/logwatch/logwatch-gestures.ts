// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The actions of Brokk's log watch cards (FR-BOSS-012, #2336), registered with the notification host in every window of
// a gold, dev or local build; a release candidate and a public release register nothing. The picker loads the first time
// a pick is needed, never with the window (NFR-BOSS-010).

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { bossName, BossNameSettingKey } from "../boss/boss-name";
import { internalChannel } from "../build/build-channel";
import { currentChannel, currentLogWatchOn } from "../build/current-build";
import { t } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { NotificationGestureResult, registerNotificationGesture } from "../notifications-store";
import {
    LogWatchAskCommand,
    LogWatchAskGesture,
    LogWatchAskRequest,
    LogWatchAskResult,
    LogWatchCandidate,
    LogWatchDeps,
    LogWatchMuteCommand,
    LogWatchMuteGesture,
    LogWatchOutcome,
    LogWatchRouteId,
    runAsk,
    runMute,
} from "./logwatch-model";

// Ask may wait for the agents' list and the brief's writing; it never waits for the agent itself.
const AskTimeoutMs = 60_000;

function ask(req: LogWatchAskRequest): Promise<LogWatchAskResult> {
    return TabRpcClient.wshRpcCall(LogWatchAskCommand, req, { route: LogWatchRouteId, timeout: AskTimeoutMs });
}

async function mute(id: string): Promise<void> {
    await TabRpcClient.wshRpcCall(LogWatchMuteCommand, { id }, { route: LogWatchRouteId });
}

async function pick(agents: LogWatchCandidate[]): Promise<string> {
    const { pickAgent } = await import("./logwatch-pick");
    return pickAgent(agents);
}

const LiveDeps: LogWatchDeps = { on: currentLogWatchOn, ask, mute, pick, word: serverErrorText, inflight: new Set() };

export function gestureResult(outcome: LogWatchOutcome): NotificationGestureResult {
    const name = bossName(globalStore.get(getSettingsKeyAtom(BossNameSettingKey as keyof SettingsType)));
    const error = outcome.errorKey ? t(outcome.errorKey, { name }) : outcome.error;
    return { ok: outcome.ok, resolve: outcome.resolve, ...(error ? { error } : {}) };
}

export function registerLogWatchGestures(deps: LogWatchDeps = LiveDeps): () => void {
    if (!internalChannel(currentChannel())) {
        return () => {};
    }
    const off = [
        registerNotificationGesture(LogWatchAskGesture, async (args) => gestureResult(await runAsk(deps, args))),
        registerNotificationGesture(LogWatchMuteGesture, async (args) => gestureResult(await runMute(deps, args))),
    ];
    return () => off.forEach((fn) => fn());
}
