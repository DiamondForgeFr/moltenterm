// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The handoff question as a system notification (#605): an agent waits 50 seconds for the developer's answer, so when
// no MoltenTerm window is in front the question also goes to the OS (emain/moltenterm-system-notify.ts decides, from
// the windows' focus, and shows each question once). Clicking it brings the window forward and shows the question's
// toast again, with its three answers: a minimised window never showed it.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { notificationToast } from "./notification-toasts";
import { MoltentermNotification } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { Toasts } from "./toast-store";

// must match NotificationKeyPrefix in pkg/molten/handoffwire/handoffwire.go
export const HandoffNotificationKeyPrefix = "agenthandoff:";

export type SystemNotifyOutcome = "shown" | "focused" | "duplicate" | "invalid" | "unsupported";

export type SystemNotifyApi = {
    moltentermSystemNotify?: (req: { id: string; title: string; body: string }) => Promise<SystemNotifyOutcome>;
    moltentermSystemNotifyClose?: (id: string) => void;
    onMoltentermSystemNotifyClick?: (callback: (id: string) => void) => () => void;
};

export function isOpenHandoffQuestion(entry: MoltentermNotification): boolean {
    return (
        entry != null &&
        typeof entry.key === "string" &&
        entry.key.startsWith(HandoffNotificationKeyPrefix) &&
        entry.resolved == null &&
        entry.archived == null
    );
}

// The questions to tell the OS about, and the ones whose OS notification should go because they were answered or
// expired.
export function handoffNotifyChanges(
    entries: MoltentermNotification[],
    asked: Set<string>
): { ask: MoltentermNotification[]; close: string[] } {
    const open = entries.filter(isOpenHandoffQuestion);
    const openIds = new Set(open.map((e) => e.id));
    return {
        ask: open.filter((e) => !asked.has(e.id)),
        close: [...asked].filter((id) => !openIds.has(id)),
    };
}

// The last outcome per question, read by the end-to-end check.
export const lastHandoffSystemNotify = new Map<string, SystemNotifyOutcome>();

export function startHandoffSystemNotifications(
    api: SystemNotifyApi = getApi() as unknown as SystemNotifyApi
): () => void {
    if (api?.moltentermSystemNotify == null) {
        return () => {};
    }
    const model = MoltentermNotifications.getInstance();
    const asked = new Set<string>();

    const update = () => {
        const { ask, close } = handoffNotifyChanges(model.entries(), asked);
        for (const id of close) {
            asked.delete(id);
            lastHandoffSystemNotify.delete(id);
            api.moltentermSystemNotifyClose?.(id);
        }
        for (const entry of ask) {
            asked.add(entry.id);
            api.moltentermSystemNotify({ id: entry.id, title: entry.title, body: entry.message ?? "" })
                .then((outcome) => lastHandoffSystemNotify.set(entry.id, outcome))
                .catch((e) => console.log("handoff system notification:", e));
        }
    };

    const showQuestion = (id: string) => {
        const entry = model.entries().find((e) => e.id === id);
        if (!isOpenHandoffQuestion(entry)) {
            return;
        }
        Toasts.getInstance().push(notificationToast(entry));
    };

    update();
    const unsubscribe = globalStore.sub(model.entriesAtom, update);
    const unlisten = api.onMoltentermSystemNotifyClick?.(showQuestion);
    return () => {
        unsubscribe();
        unlisten?.();
    };
}
