// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The group strip's Sync (FR-MC-028-AC3, FR-MC-030): the one function its button calls. It starts the same action as
// the stale notification's Sync, the dependency:sync gesture, with the same arguments, so the two never drift apart.
// Until the code that runs a sync (FR-MC-030) registers that gesture, it answers what the notification center answers
// for an action it does not know.

import { notificationGesture, NotificationGestureResult, UnknownGestureError } from "../notifications-store";
import { SyncArgs } from "./group-strip-model";

// must match DepSyncGesture in pkg/molten/mission/deps_notice.go
export const DependencySyncGesture = "dependency:sync";

export async function syncDependency(args: SyncArgs): Promise<NotificationGestureResult> {
    const gesture = notificationGesture(DependencySyncGesture);
    if (gesture == null) {
        return { ok: false, error: UnknownGestureError };
    }
    try {
        return (await gesture({ ...args })) ?? { ok: false, error: "unknown error" };
    } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}
