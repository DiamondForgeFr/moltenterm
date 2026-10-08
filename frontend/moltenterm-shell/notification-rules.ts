// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center's arbitration (FR-MC-019), as Notulia's notificationAttention.ts and notificationPrefs.ts:
// what may open the panel and for how long, and what each subject may say. Pure, so the rules can be read and tested
// apart from the timers and the store that apply them. Mirrored in pkg/molten/notifications.go for what wavesrv
// publishes.

import {
    MoltentermNotification,
    MoltentermNotificationKind,
    MoltentermNotificationSource,
} from "./notifications-model";

// Only what asks for a decision interrupts: information opening the panel would stop meaning anything.
export function deservesAttention(kind: MoltentermNotificationKind): boolean {
    return kind === "warning" || kind === "error";
}

// Long enough to read one short message; each extra one adds reading time; past the ceiling it would be a modal
// nobody asked for, and the bell keeps the messages anyway.
export const AttentionBaseMs = 2000;
export const AttentionPerExtraMs = 700;
export const AttentionMaxMs = 5000;
// Messages published back to back make one appearance.
export const AttentionCoalesceMs = 250;

export function attentionDuration(count: number): number {
    const n = Math.max(1, count);
    return Math.min(AttentionMaxMs, AttentionBaseMs + (n - 1) * AttentionPerExtraMs);
}

// What arrived since the last look, worth an appearance: new or changed, unread, still in the list, a warning or an
// error. `seen` maps an id to the `updated` time already looked at.
export function attentionArrivals(entries: MoltentermNotification[], seen: Map<string, number>): string[] {
    return entries
        .filter(
            (e) =>
                !e.read &&
                e.archived == null &&
                e.resolved == null &&
                deservesAttention(e.kind) &&
                seen.get(e.id) !== e.updated
        )
        .map((e) => e.id);
}

// How a message is said: in the center with the badge and the appearance; kept already read; or not stored at all.
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

// A failure is always told: it loses work or waits for a gesture. A warning is never dropped, at most kept quietly.
// Information follows the choice.
export function deliveryFor(kind: MoltentermNotificationKind, chosen: Delivery): Delivery {
    if (kind === "error") {
        return "notify";
    }
    if (kind === "warning" && chosen === "off") {
        return "quiet";
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

// The panel draws at most this many rows, then says how many more there are.
export const MaxRenderedRows = 100;
