// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Notifications panel of Brokk's group (FR-BOSS-009, AC19, FR-BOSS-003, FR-MC-019, #2032): one list that replaces
// À traiter and Notifications. Each row says its priority, its workspace and its date on one line, then its title, then
// its actions; only an Urgent or À répondre row has an orange button, and the × is last. The header keeps what the
// notification centre offered: the archived list and clearing it, Mark all read, Clear all with its undo, the link to the
// preferences. The work that runs keeps its group at the top. The rows are brokk-notes-model.ts's.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { tCount as translateCount, useT } from "../i18n/i18n";
import { InlineCodeText } from "../inline-code";
import { MoltenWave } from "../molten-button";
import { RowBoundary, WorkRow } from "../notification-center";
import { MaxRenderedRows, notificationSourceLabel, NotificationSubject, subjectOf } from "../notification-rules";
import { openNotificationSettings } from "../notification-settings";
import { WorkspaceLabel, workspaceLabel } from "../notification-workspace";
import {
    archivedEntries,
    checkClickable,
    displayActions,
    formatAge,
    MoltentermNotification,
    NotificationAction,
    notificationActionLabel,
    notificationMessage,
    notificationTitle,
    rowKeyAction,
} from "../notifications-model";
import { MoltentermNotifications } from "../notifications-store";
import { useRunningWork } from "../running-work";
import { showUndoToast } from "../sidebar/sidebar-undo";
import { DominoLoader } from "../suite/suite";
import { toneOf } from "../toast-model";
import { GhostButton, PrimaryButton, SecondaryButton } from "./boss-card-buttons";
import { HandoffRowView } from "./boss-handoff-row";
import { ToHandleAction, toHandleHeadline, toHandleName } from "./boss-to-handle-model";
import { isPrimaryAction, NoteRow, sourceBesideWorkspace } from "./brokk-notes-model";
import { EmptyLine, HeaderIconButton, PanelFrame, PanelProblem } from "./brokk-panel-frame";
import { goToWorkspace, labelOfRow, WorkspaceTag } from "./brokk-workspace-tag";
import { BrokkActions } from "./use-brokk-actions";

// The ordered rows of the two lists carry the same testids as the centre's and the card's rows, so a surface that knows
// one finds the other.
function PriorityMark({ priority }: { priority: NoteRow["priority"] }) {
    const t = useT();
    return (
        <span className="mt-brokk-pri" data-priority={priority} data-testid="brokk-note-priority">
            <i aria-hidden />
            {t(`boss.group.priority.${priority}`)}
        </span>
    );
}

function RowButton({
    label,
    primary,
    busy,
    disabled,
    testId,
    data,
    onClick,
}: {
    label: string;
    primary: boolean;
    busy: boolean;
    disabled?: boolean;
    testId: string;
    data?: Record<string, string>;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={primary ? PrimaryButton : SecondaryButton}
            disabled={busy || disabled}
            data-testid={testId}
            data-primary={primary ? "true" : "false"}
            {...data}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
        >
            {busy ? <DominoLoader className="mr-1" /> : null}
            {label}
            {primary ? <MoltenWave /> : null}
        </button>
    );
}

// The buttons of a row To handle: its own, in its own order, without Later and Ignorer, which have a place of their own.
function todoButtons(actions: ToHandleAction[]): ToHandleAction[] {
    return actions.filter((action) => action.run.kind !== "later" && action.run.kind !== "ignore");
}

function TodoRowBody({ row, actions }: { row: NoteRow; actions: BrokkActions }) {
    const t = useT();
    const item = row.item;
    const buttons = todoButtons(item.actions);
    const later = item.actions.find((a) => a.run.kind === "later");
    const ignore = item.actions.find((a) => a.run.kind === "ignore");
    return (
        <>
            <div
                className={cn("mt-brokk-rt", item.seen && "text-secondary")}
                data-testid="boss-card-todo-name"
                data-line={toHandleName(item)}
            >
                {toHandleHeadline(item)}
                {item.seen ? (
                    <span className="ml-1.5 text-11 font-normal text-muted" data-testid="boss-card-todo-seen">
                        {t("boss.todo.seen")}
                    </span>
                ) : null}
            </div>
            <div className="mt-brokk-ra">
                {buttons.map((action, i) => {
                    const label =
                        action.run.kind === "answer"
                            ? notificationActionLabel(action.run.action)
                            : t(action.labelKey, action.labelVars);
                    return (
                        <RowButton
                            key={action.id}
                            label={label}
                            primary={isPrimaryAction(row, i)}
                            busy={actions.busyId === `${item.key}|${action.id}`}
                            disabled={action.disabled}
                            testId="boss-card-todo-action"
                            data={{ "data-act": action.id, "data-kind": action.run.kind }}
                            onClick={() => actions.runTodo(item, action)}
                        />
                    );
                })}
                <span className="mt-brokk-ra-end">
                    {later != null ? (
                        <HeaderIconButton
                            icon="clock"
                            label={t("boss.todo.later")}
                            testId="boss-card-todo-later"
                            onClick={() => actions.runTodo(item, later)}
                        />
                    ) : null}
                    {ignore != null ? (
                        <HeaderIconButton
                            icon="xmark"
                            label={t("boss.todo.ignore")}
                            testId="boss-card-todo-ignore"
                            onClick={() => actions.runTodo(item, ignore)}
                        />
                    ) : null}
                </span>
            </div>
        </>
    );
}

// The × of a notification: it moves it to the archive.
function ClearButton({ onClear }: { onClear: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            title={t("notif.center.clearOne")}
            aria-label={t("notif.center.clearOne")}
            data-testid="notification-clear"
            onClick={(e) => {
                e.stopPropagation();
                onClear();
            }}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-11 text-muted hover:bg-hover hover:text-primary"
        >
            <i className="fa fa-solid fa-xmark" aria-hidden />
        </button>
    );
}

// A notification with no button of its own has its × on the first line, so that the row is not taller for it.
export function clearsInline(entry: MoltentermNotification, archived: boolean): boolean {
    return !archived && displayActions(entry).length === 0;
}

function EntryRowBody({
    row,
    archived,
    running,
    error,
    onAction,
    onClear,
    onSilence,
}: {
    row: NoteRow;
    archived: boolean;
    running: Record<string, boolean>;
    error: string;
    onAction: (action: NotificationAction) => void;
    onClear: () => void;
    onSilence: (subject: NotificationSubject) => void;
}) {
    const t = useT();
    const entry = row.entry;
    const actions = displayActions(entry);
    const anyRunning = actions.some((a) => running[`${entry.id}:${a.id}`]);
    const subject = subjectOf(entry.source);
    const silenceable = !archived && entry.kind === "info" && subject != null;
    const clearInline = clearsInline(entry, archived);
    const tone = toneOf(entry.kind);
    const resolved = entry.resolved != null;
    return (
        <>
            <div className={cn("mt-brokk-rt flex items-start gap-1.5", row.unread && "font-semibold")}>
                {entry.kind === "error" || entry.kind === "warning" ? (
                    <i
                        aria-label={tone.label}
                        className={cn(
                            "fa fa-solid mt-0.5 w-3.5 shrink-0 text-center",
                            `fa-${tone.icon}`,
                            tone.colorClass
                        )}
                    />
                ) : null}
                <span className="min-w-0">
                    <InlineCodeText text={notificationTitle(entry, t)} />
                </span>
                {resolved ? (
                    <span className="shrink-0 text-11 font-normal text-muted">✓ {t("notif.center.resolved")}</span>
                ) : null}
            </div>
            {entry.message ? (
                <div className="mt-0.5 line-clamp-3 text-11 text-secondary">
                    <InlineCodeText text={notificationMessage(entry)} />
                </div>
            ) : null}
            {actions.length > 0 || silenceable || (!archived && !clearInline) ? (
                <div className="mt-brokk-ra">
                    {actions.map((action, i) => (
                        <RowButton
                            key={action.id}
                            label={
                                running[`${entry.id}:${action.id}`]
                                    ? t("notif.center.running")
                                    : notificationActionLabel(action)
                            }
                            primary={isPrimaryAction(row, i)}
                            busy={false}
                            disabled={anyRunning}
                            testId="notification-action"
                            onClick={() => onAction(action)}
                        />
                    ))}
                    {!archived ? (
                        <span className="mt-brokk-ra-end">
                            {silenceable ? (
                                <button
                                    type="button"
                                    data-testid="notification-silence"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onSilence(subject);
                                    }}
                                    className={cn(
                                        GhostButton,
                                        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                    )}
                                >
                                    {t("notif.center.silence")}
                                </button>
                            ) : null}
                            {clearInline ? null : <ClearButton onClear={onClear} />}
                        </span>
                    ) : null}
                </div>
            ) : null}
            {error ? <div className="mt-1 text-11 text-danger">{error}</div> : null}
        </>
    );
}

function NoteRowView({
    row,
    label,
    now,
    archived,
    highlighted,
    running,
    error,
    actions,
    onOpen,
    onAction,
    onClear,
    onSilence,
}: {
    row: NoteRow;
    label: WorkspaceLabel;
    now: number;
    archived: boolean;
    highlighted: boolean;
    running: Record<string, boolean>;
    error: string;
    actions: BrokkActions;
    onOpen: () => void;
    onAction: (action: NotificationAction) => void;
    onClear: () => void;
    onSilence: (subject: NotificationSubject) => void;
}) {
    const t = useT();
    const rowRef = useRef<HTMLLIElement>(null);
    useEffect(() => {
        if (highlighted) {
            rowRef.current?.scrollIntoView?.({ block: "nearest" });
        }
    }, [highlighted]);
    const entry = row.entry;
    const hasOrigin = entry != null && checkClickable(entry);
    // Delete or Backspace on the row itself clears it, and the focus moves to a neighbour so the keyboard stays in the list.
    const clearAndKeepFocus = () => {
        const li = rowRef.current;
        const neighbour = li?.nextElementSibling ?? li?.previousElementSibling;
        if (neighbour instanceof HTMLElement) {
            neighbour.focus();
        }
        onClear();
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
        if (entry == null) {
            return;
        }
        const action = e.nativeEvent.isComposing
            ? null
            : rowKeyAction(e.key, { onRow: e.target === e.currentTarget, archived, hasOrigin });
        if (action == null) {
            return;
        }
        e.preventDefault();
        if (action === "clear") {
            clearAndKeepFocus();
            return;
        }
        onOpen();
    };
    const testId =
        row.source === "entry"
            ? "notification-row"
            : row.source === "todo"
              ? "boss-card-todo-row"
              : "boss-card-info-row";
    const dataKey =
        row.source === "entry"
            ? { "data-notif": entry.id }
            : row.source === "todo"
              ? { "data-todo": row.item.key, "data-tone": row.item.tone, "data-seen": row.item.seen ? "true" : "false" }
              : { "data-info": row.finished.key };
    const handoff = row.item?.handoff != null;
    const source = entry != null ? sourceBesideWorkspace(label?.name ?? "", notificationSourceLabel(entry.source)) : "";
    return (
        <li
            ref={rowRef}
            data-testid={testId}
            data-priority={row.priority}
            data-highlighted={highlighted || undefined}
            {...dataKey}
            className={cn(
                "mt-brokk-row group",
                highlighted && "molten-notification-highlight",
                entry?.resolved != null && "opacity-60",
                hasOrigin && "cursor-pointer"
            )}
            onClick={hasOrigin && !archived ? onOpen : undefined}
            onKeyDown={onKeyDown}
            role={hasOrigin ? "button" : undefined}
            tabIndex={archived || entry == null ? undefined : 0}
        >
            <div className="mt-brokk-rh">
                <PriorityMark priority={row.priority} />
                <WorkspaceTag label={label} onGo={() => goToWorkspace(label)} />
                {source !== "" ? (
                    <span className="mt-brokk-src" data-testid="notification-source">
                        {source}
                    </span>
                ) : null}
                {row.unread && row.source === "entry" ? <span className="mt-brokk-unread" aria-hidden /> : null}
                {row.since > 0 ? <span className="mt-brokk-when">{formatAge(row.since, now)}</span> : null}
                {entry != null && clearsInline(entry, archived) ? <ClearButton onClear={onClear} /> : null}
            </div>
            {handoff ? (
                <ul className="mt-1 flex flex-col">
                    <HandoffRowView item={row.item} now={now} busyId={actions.busyId} onRun={actions.runTodo} />
                </ul>
            ) : row.source === "todo" ? (
                <TodoRowBody row={row} actions={actions} />
            ) : row.source === "entry" ? (
                <EntryRowBody
                    row={row}
                    archived={archived}
                    running={running}
                    error={error}
                    onAction={onAction}
                    onClear={onClear}
                    onSilence={onSilence}
                />
            ) : (
                <div className="mt-brokk-rt" data-testid="boss-card-info-name">
                    {row.finished.name}
                    <span className="ml-1.5 font-normal text-secondary">
                        {row.finished.line.key != null ? t(row.finished.line.key, row.finished.line.vars) : ""}
                    </span>
                </div>
            )}
        </li>
    );
}

export function NotificationsPanel({
    rows,
    parked,
    now,
    workspaces,
    highlightIds,
    actions,
    onLeave,
    onClose,
    onListed,
}: {
    rows: NoteRow[];
    // The rows set aside with Later, back at the next opening.
    parked: number;
    now: number;
    workspaces: Map<string, Workspace>;
    highlightIds: string[];
    actions: BrokkActions;
    onLeave: () => void;
    onClose: () => void;
    // The notifications listed while the panel shows: the Info ones leave when Brokk closes, once consulted.
    onListed: (ids: string[]) => void;
}) {
    const t = useT();
    const model = MoltentermNotifications.getInstance();
    const entries = useAtomValue(model.entriesAtom, { store: globalStore });
    const unread = useAtomValue(model.unreadCountAtom, { store: globalStore });
    const running = useAtomValue(model.runningAtom, { store: globalStore });
    const errors = useAtomValue(model.errorsAtom, { store: globalStore });
    const currentWorkspace = useAtomValue(atoms.workspace, { store: globalStore });
    const work = useRunningWork();
    const [view, setView] = useState<"active" | "archived">("active");
    const archived = archivedEntries(entries);
    const entryRows = rows.filter((row) => row.source === "entry");
    const shown = rows.slice(0, MaxRenderedRows);
    const hidden = rows.length - shown.length;

    useEffect(() => {
        if (view === "archived" && archived.length === 0) {
            setView("active");
        }
    }, [view, archived.length]);
    const listedKey =
        view === "active" ? shown.flatMap((row) => (row.entry != null ? [row.entry.id] : [])).join(",") : "";
    useEffect(() => {
        onListed(listedKey === "" ? [] : listedKey.split(","));
    }, [listedKey, onListed]);

    // Clears the notifications of the list; the undo toast gives back exactly what was cleared (FR-MC-019, #2026). What
    // waits for an answer is a row of its agent, not a notification to clear.
    const clearAll = () => {
        const ids = entryRows.map((row) => row.entry.id);
        if (ids.length === 0) {
            return;
        }
        const undo = model.clear(ids);
        showUndoToast(translateCount("notif.center.cleared", ids.length), undo);
    };
    const labelFor = (row: NoteRow) => labelOfRow(workspaces, currentWorkspace?.oid, row, row.entry?.tabid);
    const showWork = view === "active" && work.length > 0;

    return (
        <PanelFrame
            id="notifications"
            title={t("notif.center.title")}
            count={view === "archived" ? archived.length : rows.length}
            onClose={onClose}
            beside={
                archived.length > 0 ? (
                    <HeaderIconButton
                        icon="box-archive"
                        label={t("notif.center.archived")}
                        testId="notification-list-archived"
                        pressed={view === "archived"}
                        onClick={() => setView(view === "archived" ? "active" : "archived")}
                    />
                ) : null
            }
            actions={
                view === "archived" ? (
                    <HeaderIconButton
                        icon="trash-can"
                        label={t("notif.center.clear")}
                        title={t("notif.center.clearTitle")}
                        testId="notification-clear-archive"
                        onClick={() => model.clearArchive()}
                    />
                ) : (
                    <>
                        {unread > 0 ? (
                            <HeaderIconButton
                                icon="check-double"
                                label={t("notif.center.markAllRead")}
                                testId="notification-mark-all-read"
                                onClick={() => model.markAllRead()}
                            />
                        ) : null}
                        {entryRows.length > 0 ? (
                            <HeaderIconButton
                                icon="broom"
                                label={t("notif.center.clearAll")}
                                title={t("notif.center.clearAllTitle")}
                                testId="notification-clear-all"
                                onClick={clearAll}
                            />
                        ) : null}
                        <HeaderIconButton
                            icon="sliders"
                            label={t("notif.center.settingsLink")}
                            title={`${t("notif.center.settingsLink")}: ${t("notif.center.settingsTitle")}`}
                            testId="notification-settings-link"
                            onClick={() => {
                                onLeave();
                                openNotificationSettings();
                            }}
                        />
                    </>
                )
            }
        >
            <div data-testid="notification-center">
                {showWork ? (
                    <div className="mb-1 border-b border-line">
                        <div className="pt-1 pb-0.5 text-11 font-medium tracking-wide text-muted uppercase">
                            {t("notif.center.runningHeading")}
                        </div>
                        {work.map((item) => (
                            <WorkRow
                                key={`${item.kind}:${item.id}`}
                                item={item}
                                label={workspaceLabel(item.workspaceid, workspaces, currentWorkspace?.oid)}
                                now={now}
                            />
                        ))}
                    </div>
                ) : null}
                {view === "archived" ? (
                    archived.length === 0 ? (
                        <EmptyLine text={t("notif.center.emptyArchived")} testId="notification-empty" />
                    ) : (
                        <ul className="flex flex-col">
                            {archived.map((entry) => {
                                const row = archivedRow(entry);
                                return (
                                    <RowBoundary key={entry.id}>
                                        <NoteRowView
                                            row={row}
                                            label={labelFor(row)}
                                            now={now}
                                            archived
                                            highlighted={false}
                                            running={running}
                                            error={errors[entry.id]}
                                            actions={actions}
                                            onOpen={() => {}}
                                            onAction={(action) => fireAndForget(() => model.runAction(entry, action))}
                                            onClear={() => {}}
                                            onSilence={() => {}}
                                        />
                                    </RowBoundary>
                                );
                            })}
                        </ul>
                    )
                ) : (
                    <>
                        {shown.length === 0 && !showWork ? (
                            <EmptyLine text={t("notif.center.empty")} testId="notification-empty" />
                        ) : null}
                        <ul className="flex flex-col" data-testid="boss-card-todo-list">
                            {shown.map((row) => (
                                <RowBoundary key={row.key}>
                                    <NoteRowView
                                        row={row}
                                        label={labelFor(row)}
                                        now={now}
                                        archived={false}
                                        highlighted={row.entry != null && highlightIds.includes(row.entry.id)}
                                        running={running}
                                        error={row.entry != null ? errors[row.entry.id] : ""}
                                        actions={actions}
                                        onOpen={() => {
                                            if (row.entry == null) {
                                                return;
                                            }
                                            onLeave();
                                            fireAndForget(() => model.open(row.entry));
                                        }}
                                        onAction={(action) => {
                                            if (action.kind === "open") {
                                                onLeave();
                                            }
                                            fireAndForget(() => model.runAction(row.entry, action));
                                        }}
                                        onClear={() => model.clear([row.entry.id])}
                                        onSilence={(subject) => {
                                            onLeave();
                                            openNotificationSettings(subject);
                                        }}
                                    />
                                </RowBoundary>
                            ))}
                        </ul>
                        {hidden > 0 ? (
                            <div className="py-2 text-center text-11 text-muted">
                                {t("notif.center.more", { count: hidden })}
                            </div>
                        ) : null}
                        {parked > 0 ? (
                            <div className="pt-1 text-11 text-muted" data-testid="boss-card-todo-parked">
                                {translateCount("boss.todo.parked", parked)}
                            </div>
                        ) : null}
                    </>
                )}
            </div>
            <PanelProblem problem={actions.problem} />
        </PanelFrame>
    );
}

// An archived entry as a row of the archived list: no priority is told there, the marker says where it ended.
function archivedRow(entry: MoltentermNotification): NoteRow {
    return {
        key: `entry:${entry.id}`,
        source: "entry",
        priority: entry.kind === "success" ? "done" : "info",
        since: entry.updated ?? entry.time ?? 0,
        workspaceid: entry.workspaceid ?? "",
        dir: "",
        unread: false,
        consultable: false,
        entry,
    };
}
