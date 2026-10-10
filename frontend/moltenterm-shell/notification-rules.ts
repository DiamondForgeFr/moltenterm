// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center's arbitration (FR-MC-019, FR-SHELL-055), after Notulia's notificationPrefs.ts: what toasts
// and for how long, and what each subject may say. Pure, so the rules can be read and tested apart from the timers
// and the store that apply them. Mirrored in pkg/molten/notifications.go for what wavesrv publishes.

import {
    MoltentermNotification,
    MoltentermNotificationKind,
    MoltentermNotificationSource,
} from "./notifications-model";

// Each arrival shows as a toast (FR-SHELL-055, DS-SHELL-097, toast-model.ts) instead of opening the panel. Messages
// published back to back are looked at together, so a stack of them shows at once.
export const ToastCoalesceMs = 250;

// What arrived since the last look, worth a toast: new or changed, unread, still in the list. A quiet subject's
// message is stored read, so it never toasts. `seen` maps an id to the `updated` time already looked at.
export function toastArrivals(entries: MoltentermNotification[], seen: Map<string, number>): string[] {
    return entries
        .filter((e) => !e.read && e.archived == null && e.resolved == null && seen.get(e.id) !== e.updated)
        .map((e) => e.id);
}

// How a message is said: in the center with the badge and a toast; kept already read; or not stored at all.
export type Delivery = "notify" | "quiet" | "off";

export type NotificationSubject = "agents" | "builds" | "ci" | "releases" | "updates" | "mods" | "dependencies";

// must match NotificationSubjects in pkg/molten/notifications.go
export const NotificationSubjects: {
    id: NotificationSubject;
    label: string;
    sources: MoltentermNotificationSource[];
}[] = [
    { id: "agents", label: "Agents", sources: ["agent"] },
    { id: "builds", label: "Local builds", sources: ["build"] },
    { id: "ci", label: "CI", sources: ["ci"] },
    { id: "releases", label: "Releases", sources: ["release"] },
    { id: "updates", label: "MoltenTerm updates", sources: ["moltenterm"] },
    { id: "mods", label: "Mods", sources: ["mod"] },
    { id: "dependencies", label: "Dependencies", sources: ["deps"] },
];

export const DeliveryLabels: Record<Delivery, string> = { notify: "Notify", quiet: "Quiet", off: "Off" };

// must match NotificationPrefsMetaKey in pkg/molten/notifications.go
export const NotificationPrefsMetaKey = "molten:notifprefs";

export type NotificationPrefs = Partial<Record<NotificationSubject, Delivery>>;

export function subjectOf(source: string): NotificationSubject {
    return NotificationSubjects.find((s) => (s.sources as string[]).includes(source))?.id ?? null;
}

// A failure is always told: it loses work or waits for a gesture. Anything else follows the choice: Off keeps nothing,
// warnings included (#409), since an agent waiting is a warning and keeping those quietly filled the center of a user
// who had turned agents off.
export function deliveryFor(kind: MoltentermNotificationKind, chosen: Delivery): Delivery {
    if (kind === "error") {
        return "notify";
    }
    return chosen ?? "notify";
}

// Anything unreadable is the default.
export function parsePrefs(value: unknown): NotificationPrefs {
    if (value == null || typeof value !== "object") {
        return {};
    }
    const rtn: NotificationPrefs = {};
    for (const { id } of NotificationSubjects) {
        const chosen = (value as Record<string, unknown>)[id];
        if (chosen === "notify" || chosen === "quiet" || chosen === "off") {
            rtn[id] = chosen;
        }
    }
    return rtn;
}

export function deliveryOf(
    input: { kind?: MoltentermNotificationKind; source: string },
    prefs: NotificationPrefs
): Delivery {
    const subject = subjectOf(input.source);
    if (subject == null) {
        return "notify";
    }
    return deliveryFor(input.kind ?? "info", prefs[subject] ?? "notify");
}

// What the center lists and counts: a subject turned off shows nothing, not even what it said before it was turned
// off (#409); errors stay, since they are always told.
export function shownEntries(entries: MoltentermNotification[], prefs: NotificationPrefs): MoltentermNotification[] {
    return entries.filter((e) => deliveryOf(e, prefs) !== "off");
}

// The bell's count, kept to one or two characters.
export function badgeCount(count: number): string {
    if (count <= 0) {
        return "";
    }
    return count > 9 ? "9+" : String(count);
}

// The panel draws at most this many rows, then says how many more there are.
export const MaxRenderedRows = 100;
