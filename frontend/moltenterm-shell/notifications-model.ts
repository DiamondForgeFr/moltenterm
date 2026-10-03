// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center's data (FR-SHELL-002, DS-SHELL-003). Each notification is one key of the client object's
// meta, "molten:notif:<id>". Wave persists that meta, sends it to every window, and merges updates key by key, so
// windows adding at the same time never overwrite each other; a null value deletes a key.

export const NotificationKeyPrefix = "molten:notif:";
export const MaxNotifications = 500;

export type MoltentermNotificationSource = "agent" | "mod" | "moltenterm";
export type MoltentermNotificationKind = "info" | "success" | "warning" | "error";

export type MoltentermNotificationInput = {
    source: MoltentermNotificationSource;
    title: string;
    message?: string;
    kind?: MoltentermNotificationKind;
    workspaceid?: string;
    tabid?: string;
    blockid?: string;
    read?: boolean;
};

export type MoltentermNotification = MoltentermNotificationInput & {
    id: string;
    time: number;
    kind: MoltentermNotificationKind;
    read: boolean;
};

export type MetaUpdate = Record<string, any>;

export function parseNotifications(meta: Record<string, any>): MoltentermNotification[] {
    const rtn: MoltentermNotification[] = [];
    for (const [key, value] of Object.entries(meta ?? {})) {
        if (!key.startsWith(NotificationKeyPrefix) || value == null || typeof value !== "object") {
            continue;
        }
        if (typeof value.title !== "string" || typeof value.time !== "number") {
            continue;
        }
        rtn.push({
            ...value,
            id: key.slice(NotificationKeyPrefix.length),
            kind: value.kind ?? "info",
            read: !!value.read,
        });
    }
    return rtn.sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
}

export type WorkspaceTabs = { oid: string; tabids?: string[] };

// Where a notification raised by a view belongs (#80). Since #68 the views of a workspace left stay alive while the
// window shows another workspace: such a view's tab is not one of the shown workspace's tabs, and pairing the two sent
// the user into another workspace's tab. A location the view cannot vouch for is left out.
export function notificationLocation(
    input: MoltentermNotificationInput,
    shownWs: WorkspaceTabs,
    viewTabId: string
): Pick<MoltentermNotificationInput, "workspaceid" | "tabid"> {
    const shownTabs = shownWs?.tabids ?? [];
    let tabid = input.tabid;
    if (tabid == null && shownTabs.includes(viewTabId) && (input.workspaceid ?? shownWs.oid) === shownWs.oid) {
        tabid = viewTabId;
    }
    let workspaceid = input.workspaceid;
    if (workspaceid == null && shownTabs.includes(tabid ?? viewTabId)) {
        workspaceid = shownWs.oid;
    }
    return { workspaceid, tabid };
}

// The tab opening a notification activates: only one of the shown workspace's own tabs (#80).
export function notificationTabToActivate(
    entry: MoltentermNotification,
    shownWs: WorkspaceTabs,
    activeTabId: string
): string {
    if (!entry.tabid || entry.tabid === activeTabId || !(shownWs?.tabids ?? []).includes(entry.tabid)) {
        return null;
    }
    return entry.tabid;
}

export function unreadByWorkspace(entries: MoltentermNotification[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        if (entry.read || !entry.workspaceid) {
            continue;
        }
        counts.set(entry.workspaceid, (counts.get(entry.workspaceid) ?? 0) + 1);
    }
    return counts;
}

export function makeNotificationId(time: number, random: () => number = Math.random): string {
    return `${time.toString(36)}-${Math.floor(random() * 36 ** 6)
        .toString(36)
        .padStart(6, "0")}`;
}

// The update that adds one notification and drops the oldest ones beyond the cap.
export function addUpdate(
    existing: MoltentermNotification[],
    input: MoltentermNotificationInput,
    now: number,
    id: string
): MetaUpdate {
    const { read, ...rest } = input;
    const update: MetaUpdate = {
        [NotificationKeyPrefix + id]: { ...rest, kind: input.kind ?? "info", time: now, read: !!read },
    };
    const keep = MaxNotifications - 1;
    const oldestFirst = [...existing].sort((a, b) => a.time - b.time);
    for (const entry of oldestFirst.slice(0, Math.max(0, oldestFirst.length - keep))) {
        update[NotificationKeyPrefix + entry.id] = null;
    }
    return update;
}

export function readUpdate(entries: MoltentermNotification[], ids: string[]): MetaUpdate {
    const wanted = new Set(ids);
    const update: MetaUpdate = {};
    for (const entry of entries) {
        if (entry.read || !wanted.has(entry.id)) {
            continue;
        }
        const { id, ...value } = entry;
        update[NotificationKeyPrefix + id] = { ...value, read: true };
    }
    return update;
}

export function readAllUpdate(entries: MoltentermNotification[]): MetaUpdate {
    return readUpdate(
        entries,
        entries.map((e) => e.id)
    );
}

export function formatAge(time: number, now: number): string {
    const seconds = Math.max(0, Math.round((now - time) / 1000));
    if (seconds < 60) {
        return "now";
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h`;
    }
    return `${Math.round(hours / 24)} d`;
}
