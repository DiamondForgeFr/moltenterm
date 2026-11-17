// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Notifications panel of Brokk's group (FR-BOSS-009, AC19, FR-BOSS-003, FR-MC-019, #2032): one list that replaces
// À traiter and Notifications. It is read from the models that already hold each fact (the rows To handle, the
// notification centre's entries, the agents that finished), so nothing here is a second source of truth. Each row has a
// priority, from the severity of AC3 (Urgent, À répondre, Info, Fait); the list is sorted by priority and then by date; only
// Urgent and À répondre rows have an orange (primary) button; an Info notification leaves once the developer consulted it.
// Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { AgentHandoffNotificationKeyPrefix } from "../agent-handoff-types";
import { checkNeedsAnswer } from "../notification-attention";
import {
    activeEntries,
    checkClickable,
    checkUnread,
    ClickActionId,
    displayActions,
    MoltentermNotification,
} from "../notifications-model";
import { HandledRow } from "./boss-handled";
import { infoHandledRow, InfoItem, ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import { Severity } from "./brokk-queue";
import { BrokkEvent, BrokkEventKind, severityOf, VisitSettings } from "./brokk-visit-events";

export type NotePriority = "urgent" | "answer" | "info" | "done";

export const NotePriorities: NotePriority[] = ["urgent", "answer", "info", "done"];

// grave is Urgent, important (anything that waits for an answer) is À répondre, neutre is Info, bonne is Fait.
const PriorityOfSeverity: Record<Severity, NotePriority> = {
    grave: "urgent",
    important: "answer",
    neutre: "info",
    bonne: "done",
};

export function priorityOf(severity: Severity): NotePriority {
    return PriorityOfSeverity[severity];
}

// Where a row comes from: a row To handle, a notification of the centre, an agent that finished.
export type NoteSource = "todo" | "entry" | "finished";

export type NoteRow = {
    key: string;
    source: NoteSource;
    priority: NotePriority;
    // When it started, in Unix ms; 0 when the source does not know.
    since: number;
    // The workspace it belongs to ("" when the source does not know it: a pull request names a project folder, dir).
    workspaceid: string;
    dir: string;
    unread: boolean;
    // An Info notification: it goes to the archive once the developer consulted it, when Brokk closes. A row that stands
    // for a fact still true (a failing CI, a pull request ready) never does: it leaves when the fact is gone.
    consultable: boolean;
    item?: ToHandleItem;
    entry?: MoltentermNotification;
    finished?: InfoItem;
};

// The event a row To handle stands for, to read its severity from the visit model (AC3): an agent that waits is blocked
// (grave once it waited three times the threshold), one that stopped is an error, a failing CI and a ready pull request
// are the events of that name, anything else that waits for the developer is important.
function todoKind(item: ToHandleItem): BrokkEventKind {
    if (item.key.startsWith("agent:")) {
        return item.tone === "error" ? "error" : "blocked";
    }
    if (item.key.startsWith("ci:")) {
        return "ci";
    }
    if (item.key.startsWith("ready:")) {
        return "ready";
    }
    return "error";
}

export function todoSeverity(item: ToHandleItem, settings: VisitSettings, now: number): Severity {
    const event: BrokkEvent = { key: item.key, kind: todoKind(item), since: item.since };
    return severityOf(event, settings, now);
}

// A notification that needs no answer: a success is good news, anything else is for information. What needs an answer is
// a row To handle already.
export function entrySeverity(entry: MoltentermNotification): Severity {
    return entry.kind === "success" ? "bonne" : "neutre";
}

export type NotesInput = {
    toHandle: ToHandleList;
    // The notifications the developer sees (not filtered out by the preferences).
    entries: MoltentermNotification[];
    settings: VisitSettings;
    now: number;
};

function bySeverity(a: NoteRow, b: NoteRow): number {
    return (
        NotePriorities.indexOf(a.priority) - NotePriorities.indexOf(b.priority) ||
        b.since - a.since ||
        (a.key < b.key ? -1 : 1)
    );
}

// The notification of the finish may be stamped a little before the agent's state.
export const ToldSlackMs = 60_000;

// An archived "is done" notification still tells the finish it was raised for (#2195): archiving the card must not make the
// agent's own row appear in its place. One from an earlier finish of the same agent does not.
export function checkToldByNotification(info: InfoItem, entries: MoltentermNotification[]): boolean {
    const blockid = info.key.replace(/^done:/, "");
    return entries.some(
        (entry) =>
            entry.titlecode === "agentdone" &&
            entry.blockid === blockid &&
            (entry.archived == null || (entry.updated ?? entry.time ?? 0) >= (info.since ?? 0) - ToldSlackMs)
    );
}

// The agents whose Done card is still in the Notifications panel (#2210): its "is done" notification is not archived, or,
// without one, its own card is not archived. Archiving the card is the developer's own gesture: the finish it told
// leaves Brokk's badge with it.
export function openDoneBlocks(list: ToHandleList, entries: MoltentermNotification[]): ReadonlySet<string> {
    const blocks = new Set<string>();
    for (const info of list?.info ?? []) {
        const blockid = info.key.replace(/^done:/, "");
        const told = checkToldByNotification(info, entries ?? []);
        const open = (entries ?? []).some(
            (entry) => entry.titlecode === "agentdone" && entry.blockid === blockid && entry.archived == null
        );
        if (!told || open) {
            blocks.add(blockid);
        }
    }
    return blocks;
}

// Every row of the Notifications panel, the most urgent first, then the newest.
export function buildNotes(input: NotesInput): NoteRow[] {
    const todo: NoteRow[] = (input.toHandle?.items ?? []).map((item) => ({
        key: `todo:${item.key}`,
        source: "todo",
        priority: priorityOf(todoSeverity(item, input.settings, input.now)),
        since: item.since,
        workspaceid: item.workspaceid ?? "",
        dir: item.dir ?? "",
        unread: !item.seen,
        consultable: false,
        item,
    }));
    // A question the agents or the hand-offs ask is a row To handle already: only what needs no answer is listed here.
    const entries: NoteRow[] = activeEntries(input.entries ?? [])
        .filter((entry) => !checkNeedsAnswer(entry))
        .map((entry) => {
            const priority = priorityOf(entrySeverity(entry));
            return {
                key: `entry:${entry.id}`,
                source: "entry",
                priority,
                since: entry.updated ?? entry.time ?? 0,
                workspaceid: entry.workspaceid ?? "",
                dir: "",
                unread: checkUnread(entry),
                consultable: priority === "info",
                entry,
            };
        });
    // An agent that finished is told once: by its notification when it raised one, else by the row of the agent states.
    const finished: NoteRow[] = (input.toHandle?.info ?? [])
        .filter((info) => !checkToldByNotification(info, input.entries ?? []))
        .map((info) => ({
            key: `finished:${info.key}`,
            source: "finished",
            priority: "done",
            since: info.since ?? 0,
            workspaceid: info.workspaceid ?? "",
            dir: "",
            unread: false,
            consultable: false,
            finished: info,
        }));
    return [...todo, ...entries, ...finished].sort(bySeverity);
}

// A source that says the workspace's name again (the app's own update in the MoltenTerm workspace reads "MoltenTerm ·
// MoltenTerm") adds nothing: the row shows the name once, as the workspace. Returns what to show after the workspace.
export function sourceBesideWorkspace(workspaceName: string, source: string): string {
    const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
    return source === "" || same(workspaceName ?? "", source) ? "" : source;
}

// The orange button is for what asks the developer to act: Urgent and À répondre, and only one per row.
export function primaryAllowed(priority: NotePriority): boolean {
    return priority === "urgent" || priority === "answer";
}

// Whether the button at this place of the row is the primary one.
export function isPrimaryAction(row: Pick<NoteRow, "priority">, index: number, offered: boolean = true): boolean {
    return offered && index === 0 && primaryAllowed(row.priority);
}

// Where a card comes from, as the source a notification names ("agent", "ci"), for the first line of every kind of card
// (#2195): "" when the card says no source. "pr" and "handoff" are the two sources of a row that is no notification.
export function rowSourceId(row: NoteRow): string {
    if (row.entry != null) {
        return row.entry.source;
    }
    if (row.finished != null) {
        return "agent";
    }
    const item = row.item;
    if (item == null) {
        return "";
    }
    if (item.handoff != null) {
        return "handoff";
    }
    if (item.key.startsWith("notif:")) {
        return item.notice?.source ?? "";
    }
    if (item.key.startsWith("agent:")) {
        return "agent";
    }
    if (item.key.startsWith("ci:")) {
        return "ci";
    }
    return item.key.startsWith("ready:") ? "pr" : "";
}

// Where a card that leads somewhere leads (#2195): the place a notification comes from, or the agent that finished.
export type CardTarget = "origin" | "agent";

export function cardTarget(row: NoteRow, archived = false): CardTarget {
    if (archived) {
        return null;
    }
    if (row.source === "entry") {
        return row.entry != null && checkClickable(row.entry) ? "origin" : null;
    }
    if (row.source === "finished") {
        return row.finished?.blockid || row.finished?.sessionid ? "agent" : null;
    }
    return null;
}

// Whether the card shows the Integration's "Go to →" on its action line: it has a target, and none of its own actions
// already goes there (the "Go to the terminal" of an agent's notification, a pull request's card).
export function cardGoTo(row: NoteRow, archived = false): CardTarget {
    const target = cardTarget(row, archived);
    if (target !== "origin") {
        return target;
    }
    return displayActions(row.entry).some((a) => a.kind === "open" || a.id === ClickActionId) ? null : target;
}

// What archiving cards does (#2195): the notifications go to the Archived list, and a card that stands for a fact (an
// agent, a CI, a pull request, a hand-off request, an agent that finished) is marked as handled for the episode it shows.
// rowKeys: the rows To handle among the cards, which the undo gives back as the developer left them, never as news (#2210).
export type ArchivePlan = { entryIds: string[]; marks: HandledRow[]; rowKeys?: string[] };

export function archivePlan(rows: NoteRow[], entries: MoltentermNotification[] = []): ArchivePlan {
    const entryIds = new Set<string>();
    const marks = new Map<string, HandledRow>();
    const rowKeys = new Set<string>();
    for (const row of rows) {
        if (row.item != null) {
            rowKeys.add(row.item.key);
        }
        if (row.entry != null) {
            entryIds.add(row.entry.id);
            continue;
        }
        if (row.finished != null) {
            const mark = infoHandledRow(row.finished);
            marks.set(mark.key, mark);
            continue;
        }
        const item = row.item;
        if (item == null) {
            continue;
        }
        if (item.notice != null) {
            entryIds.add(item.notice.id);
        }
        if (item.handoff != null) {
            const key = AgentHandoffNotificationKeyPrefix + item.handoff.requestid;
            entries.filter((entry) => entry.key === key && entry.archived == null).forEach((e) => entryIds.add(e.id));
        }
        if (!item.key.startsWith("notif:")) {
            marks.set(item.key, { key: item.key, since: item.since, tone: item.tone });
        }
    }
    return { entryIds: [...entryIds], marks: [...marks.values()], rowKeys: [...rowKeys] };
}

// The notifications to settle when Brokk closes: the Info ones the developer saw listed.
export function consultedIds(rows: NoteRow[], listed: ReadonlySet<string>): string[] {
    return rows
        .filter((row) => row.consultable && row.entry != null && listed.has(row.entry.id))
        .map((row) => row.entry.id);
}

export type NoteFacts = {
    // Rows that ask for something: the badge of the Notifications icon counts them.
    count: number;
    urgentOrAnswer: boolean;
    unread: boolean;
};

export function noteFacts(rows: NoteRow[]): NoteFacts {
    const counted = rows.filter((row) => row.priority !== "done");
    return {
        count: counted.length,
        urgentOrAnswer: rows.some((row) => primaryAllowed(row.priority) && row.unread),
        // A Fait row that is news (a pull request ready to merge) is unread too: the group opens on it before a running
        // download (#2085).
        unread: rows.some((row) => row.unread),
    };
}
