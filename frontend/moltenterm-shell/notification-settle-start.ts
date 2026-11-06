// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Starts the watchers that settle notifications from the facts (notification-settle.ts), once per tab view with the
// notification center: the agent that stopped asking, and the source brought on screen.

import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { makeSeenViewAtom } from "./agent-seen";
import { AgentStates } from "./agent-state-store";
import { AgentMovedOnWatcher, LookSource, NotificationLookWatcher } from "./notification-settle";
import { MoltentermNotifications } from "./notifications-store";

export function startNotificationSettling(): () => void {
    const notifications = MoltentermNotifications.getInstance();
    const agents = AgentStates.getInstance();
    const viewAtom = makeSeenViewAtom();
    const lookAtom = atom<LookSource>((get) => ({ entries: get(notifications.entriesAtom), view: get(viewAtom) }));
    const stops = [
        new NotificationLookWatcher(lookAtom, (ids) => notifications.handle(ids)).start(),
        new AgentMovedOnWatcher(
            {
                dataAtom: agents.dataAtom,
                loadedAtom: agents.loadedAtom,
                entries: () => notifications.entries(),
                now: () => Date.now(),
            },
            (ids) => fireAndForget(() => notifications.handle(ids))
        ).start(),
    ];
    return () => stops.forEach((stop) => stop());
}
