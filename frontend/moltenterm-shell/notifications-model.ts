// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The notification center's data (FR-SHELL-002, DS-SHELL-003, FR-MC-010, DS-MC-009). Each notification is one key of
// the client object's meta, "molten:notif:<id>". Wave persists that meta, sends it to every window, and merges updates
// key by key, so windows adding at the same time never overwrite each other; a null value deletes a key.
// pkg/molten/notifications.go applies the same rules for what wavesrv publishes: keep both in step.

import { t } from "./i18n/i18n";
import { ServerText, serverText } from "./i18n/server-text";

export const NotificationKeyPrefix = "molten:notif:";
export const MaxNotifications = 500;
// Closed notifications (resolved, archived, or read without a key) are kept this long, and this many per key.
export const ClosedRetentionMs = 30 * 24 * 60 * 60 * 1000;
export const MaxClosedPerKey = 20;
// Three since #276: the ask-once notification of the sleep policy offers its three modes.
export const MaxActions = 3;

export type MoltentermNotificationSource =
    | "agent"
    | "sessions"
    | "mod"
    | "moltenterm"
    | "build"
    | "ci"
    | "release"
    | "deps";
export type MoltentermNotificationKind = "info" | "success" | "warning" | "error";

// "open" goes where it points (a workspace, a tab, a block, or a view opened in the active tab); "gesture" runs a
// handler registered by name (registerNotificationGesture), so it still works after a restart. A lasting action stays
// once the notification is resolved or archived.
export type NotificationAction = {
    id: string;
    label: string;
    kind: "open" | "gesture";
    workspaceid?: string;
    tabid?: string;
    blockid?: string;
    view?: string;
    gesture?: string;
    args?: Record<string, any>;
    lasting?: boolean;
    // The label as wavesrv words it in the interface language (#656).
    labeltext?: ServerText;
};

export type MoltentermNotificationInput = {
    // The situation it tells about: publishing the same key again updates the open notification.
    key?: string;
    source: MoltentermNotificationSource;
    title: string;
    // A title wavesrv publishes in English with a code the window translates (#727): titlevars fill its placeholders.
    titlecode?: string;
    titlevars?: Record<string, string>;
    // A title or message wavesrv wrote itself, with its code (#656).
    titletext?: ServerText;
    message?: string;
    messagetext?: ServerText;
    kind?: MoltentermNotificationKind;
    workspaceid?: string;
    tabid?: string;
    blockid?: string;
    actions?: NotificationAction[];
    read?: boolean;
    // App-wide news (the gold update): it belongs to no workspace, so it is not given the shown one.
    global?: boolean;
};

export type MoltentermNotification = MoltentermNotificationInput & {
    id: string;
    time: number;
    // Last time its content changed; the list is sorted on it.
    updated: number;
    kind: MoltentermNotificationKind;
    read: boolean;
    resolved?: number;
    archived?: number;
};

export type MetaUpdate = Record<string, any>;

function readAction(value: any): NotificationAction {
    if (value == null || typeof value !== "object" || typeof value.id !== "string" || typeof value.label !== "string") {
        return null;
    }
    if (value.kind === "gesture") {
        return typeof value.gesture === "string" ? (value as NotificationAction) : null;
    }
    if (value.kind === "open") {
        return value as NotificationAction;
    }
    return null;
}

// must match the NotificationTitle* codes in pkg/molten/notifications.go
export const NotificationTitleKeys: Record<string, string> = {
    agentwaiting: "notif.title.agentWaiting",
    agentdone: "notif.title.agentDone",
    bell: "notif.title.bell",
};

// The title in the user's language: a known code is translated, anything else is shown as published.
export function notificationTitle(
    entry: Pick<MoltentermNotificationInput, "title" | "titlecode" | "titlevars" | "titletext">,
    translate: (key: string, vars?: Record<string, string>) => string = t
): string {
    const code = entry.titlecode ?? "";
    const key = Object.prototype.hasOwnProperty.call(NotificationTitleKeys, code) ? NotificationTitleKeys[code] : null;
    if (key == null) {
        return serverText(entry.titletext, entry.title);
    }
    return translate(key, entry.titlevars ?? {});
}

// The message in the user's language when wavesrv wrote it with a code; an agent's words show as they are.
export function notificationMessage(entry: Pick<MoltentermNotificationInput, "message" | "messagetext">): string {
    return serverText(entry.messagetext, entry.message ?? "");
}

export function notificationActionLabel(action: Pick<NotificationAction, "label" | "labeltext">): string {
    return serverText(action.labeltext, action.label);
}

export function parseNotifications(meta: Record<string, any>): MoltentermNotification[] {
    const rtn: MoltentermNotification[] = [];
    for (const [key, value] of Object.entries(meta ?? {})) {
        if (!key.startsWith(NotificationKeyPrefix) || value == null || typeof value !== "object") {
            continue;
        }
        if (typeof value.title !== "string" || typeof value.time !== "number") {
            continue;
        }
        const actions = Array.isArray(value.actions)
            ? value.actions
                  .map(readAction)
                  .filter((a: NotificationAction) => a != null)
                  .slice(0, MaxActions)
            : [];
        rtn.push({
            ...value,
            id: key.slice(NotificationKeyPrefix.length),
            kind: value.kind ?? "info",
            read: !!value.read,
            updated: typeof value.updated === "number" ? value.updated : value.time,
            actions,
        });
    }
    return sortNewestFirst(rtn);
}

export function sortNewestFirst(entries: MoltentermNotification[]): MoltentermNotification[] {
    return entries.sort((a, b) => b.updated - a.updated || b.time - a.time || (a.id < b.id ? 1 : -1));
}

// A situation still going on: neither resolved nor archived. A notification without a key is one moment, not a
// situation: it stops being open once read.
export function checkOpen(entry: MoltentermNotification): boolean {
    if (entry.resolved != null || entry.archived != null) {
        return false;
    }
    return entry.key ? true : !entry.read;
}

export function checkUnread(entry: MoltentermNotification): boolean {
    return !entry.read && entry.resolved == null && entry.archived == null;
}

export function unreadCount(entries: MoltentermNotification[]): number {
    return entries.filter(checkUnread).length;
}

// The bell's dot: a situation still open although its message was read.
export function openCount(entries: MoltentermNotification[]): number {
    return entries.filter((e) => checkOpen(e) && e.read).length;
}

export function activeEntries(entries: MoltentermNotification[]): MoltentermNotification[] {
    return entries.filter((e) => e.archived == null);
}

export function archivedEntries(entries: MoltentermNotification[]): MoltentermNotification[] {
    return entries.filter((e) => e.archived != null);
}

// Once a notification is resolved or archived, only its lasting actions still make sense.
export function visibleActions(entry: MoltentermNotification): NotificationAction[] {
    const actions = (entry.actions ?? []).slice(0, MaxActions);
    if (entry.resolved == null && entry.archived == null) {
        return actions;
    }
    return actions.filter((a) => a.lasting);
}

export const GoToTerminalActionId = "goto-terminal";
// The English label; the action shows t("notif.goToTerminal").
export const GoToTerminalLabel = "Go to the terminal";

// An agent waiting for an answer, or stopped on an error, is answered in its terminal (FR-SHELL-055): its notification
// offers the way there first, whichever agent raised it and whatever wavesrv stored with it.
export function checkGoToTerminal(entry: MoltentermNotification): boolean {
    return (
        entry.source === "agent" &&
        !!entry.blockid &&
        (entry.kind === "warning" || entry.kind === "error") &&
        entry.resolved == null &&
        entry.archived == null
    );
}

export function displayActions(entry: MoltentermNotification): NotificationAction[] {
    const actions = visibleActions(entry);
    if (!checkGoToTerminal(entry) || actions.some((a) => a.kind === "open" && a.blockid === entry.blockid)) {
        return actions;
    }
    const goTo: NotificationAction = {
        id: GoToTerminalActionId,
        label: t("notif.goToTerminal"),
        kind: "open",
        workspaceid: entry.workspaceid,
        tabid: entry.tabid,
        blockid: entry.blockid,
    };
    return [goTo, ...actions].slice(0, MaxActions);
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
    entry: Pick<MoltentermNotification, "tabid">,
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
        if (!checkUnread(entry) || !entry.workspaceid) {
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

function stored(entry: MoltentermNotification): Record<string, any> {
    const { id: _id, ...value } = entry;
    return value;
}

function canonical(value: any): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
    }
    if (value != null && typeof value === "object") {
        return `{${Object.keys(value)
            .filter((k) => value[k] != null)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}

// What a publish compares: the content the user sees, not when or where it was read.
function samePayload(entry: MoltentermNotification, input: MoltentermNotificationInput): boolean {
    const pick = (v: MoltentermNotificationInput) => ({
        kind: v.kind ?? "info",
        title: v.title,
        message: v.message ?? "",
        actions: (v.actions ?? []).slice(0, MaxActions),
    });
    return canonical(pick(entry)) === canonical(pick(input));
}

function checkClosed(entry: MoltentermNotification): boolean {
    return !checkOpen(entry);
}

// The notifications to drop: closed ones past their time, beyond MaxClosedPerKey for their key, then the oldest
// closed ones while the total is above MaxNotifications. An open notification is never dropped.
export function pruneIds(entries: MoltentermNotification[], now: number): string[] {
    const drop = new Set<string>();
    const closed = entries.filter(checkClosed).sort((a, b) => a.updated - b.updated);
    for (const entry of closed) {
        if (now - entry.updated > ClosedRetentionMs) {
            drop.add(entry.id);
        }
    }
    const byKey = new Map<string, MoltentermNotification[]>();
    for (const entry of closed) {
        if (!entry.key || drop.has(entry.id)) {
            continue;
        }
        byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
    }
    for (const group of byKey.values()) {
        group.slice(0, Math.max(0, group.length - MaxClosedPerKey)).forEach((e) => drop.add(e.id));
    }
    let total = entries.length - drop.size;
    for (const entry of closed) {
        if (total <= MaxNotifications) {
            break;
        }
        if (!drop.has(entry.id)) {
            drop.add(entry.id);
            total--;
        }
    }
    return [...drop];
}

// The open "waiting" notifications an agent's newer notification makes outdated (#748): the same terminal's agent has
// moved on, so the older one folds into the archive and stops offering its terminal. Must match supersededAgentWaits
// in pkg/molten/notifications.go.
export function supersededAgentWaits(
    existing: MoltentermNotification[],
    input: MoltentermNotificationInput
): MoltentermNotification[] {
    if (input.source !== "agent" || !input.blockid) {
        return [];
    }
    return existing.filter(
        (e) =>
            e.source === "agent" &&
            e.blockid === input.blockid &&
            e.kind === "warning" &&
            e.resolved == null &&
            e.archived == null
    );
}

// The update that publishes one notification. With a key and an open notification for it: the same content changes
// nothing (null), new content updates it in place and makes it unread again. Otherwise a new notification is added,
// and what the retention rule drops goes with it.
export function publishUpdate(
    existing: MoltentermNotification[],
    input: MoltentermNotificationInput,
    now: number,
    id: string
): MetaUpdate {
    const actions = (input.actions ?? []).slice(0, MaxActions);
    const { read, ...rest } = input;
    const open = input.key ? existing.find((e) => e.key === input.key && checkOpen(e)) : null;
    if (open != null) {
        if (samePayload(open, { ...input, actions })) {
            return null;
        }
        return {
            [NotificationKeyPrefix + open.id]: stored({
                ...open,
                ...rest,
                kind: input.kind ?? "info",
                actions,
                updated: now,
                read: !!read,
            }),
        };
    }
    const entry: MoltentermNotification = {
        ...rest,
        id,
        kind: input.kind ?? "info",
        actions,
        time: now,
        updated: now,
        read: !!read,
    };
    const update: MetaUpdate = { [NotificationKeyPrefix + id]: stored(entry) };
    for (const outdated of supersededAgentWaits(existing, input)) {
        update[NotificationKeyPrefix + outdated.id] = stored({ ...outdated, resolved: now, archived: now, read: true });
    }
    for (const dropId of pruneIds([...existing, entry], now)) {
        if (dropId !== id) {
            update[NotificationKeyPrefix + dropId] = null;
        }
    }
    return update;
}

function changeUpdate(
    entries: MoltentermNotification[],
    pick: (e: MoltentermNotification) => boolean,
    change: (e: MoltentermNotification) => Partial<MoltentermNotification>
): MetaUpdate {
    const update: MetaUpdate = {};
    for (const entry of entries) {
        if (!pick(entry)) {
            continue;
        }
        update[NotificationKeyPrefix + entry.id] = stored({ ...entry, ...change(entry) });
    }
    return update;
}

// Closes the situation: every open notification for the key.
export function resolveUpdate(entries: MoltentermNotification[], key: string, now: number): MetaUpdate {
    return changeUpdate(
        entries,
        (e) => !!key && e.key === key && e.resolved == null && e.archived == null,
        () => ({ resolved: now })
    );
}

export function readUpdate(entries: MoltentermNotification[], ids: string[]): MetaUpdate {
    const wanted = new Set(ids);
    return changeUpdate(
        entries,
        (e) => !e.read && wanted.has(e.id),
        () => ({ read: true })
    );
}

export function readAllUpdate(entries: MoltentermNotification[]): MetaUpdate {
    return readUpdate(
        entries,
        entries.filter(checkUnread).map((e) => e.id)
    );
}

// Archiving twice keeps the first date.
export function archiveUpdate(entries: MoltentermNotification[], ids: string[], now: number): MetaUpdate {
    const wanted = new Set(ids);
    return changeUpdate(
        entries,
        (e) => wanted.has(e.id) && e.archived == null,
        () => ({ archived: now, read: true })
    );
}

export function archiveResolvedUpdate(entries: MoltentermNotification[], now: number): MetaUpdate {
    return archiveUpdate(
        entries,
        entries.filter((e) => e.resolved != null).map((e) => e.id),
        now
    );
}

export function clearArchiveUpdate(entries: MoltentermNotification[]): MetaUpdate {
    const update: MetaUpdate = {};
    for (const entry of archivedEntries(entries)) {
        update[NotificationKeyPrefix + entry.id] = null;
    }
    return update;
}

export function formatAge(time: number, now: number): string {
    const seconds = Math.max(0, Math.round((now - time) / 1000));
    if (seconds < 60) {
        return t("notif.age.now");
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return t("notif.age.minutes", { count: minutes });
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return t("notif.age.hours", { count: hours });
    }
    return t("notif.age.days", { count: Math.round(hours / 24) });
}
