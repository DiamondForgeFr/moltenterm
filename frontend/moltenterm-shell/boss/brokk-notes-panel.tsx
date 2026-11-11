// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Notifications panel of Brokk's group (FR-BOSS-009, AC19, AC65 to AC70, FR-BOSS-003, FR-MC-019, #2032, #2195): one
// list that replaces À traiter and Notifications. Every card, of every kind, has the same anatomy: a first line (its
// priority, its workspace, its source, its date), one title line, and one action line, with the card's own actions on the
// left and, on the right, the Integration's "Go to →" where the card leads somewhere, then Archive. Only an Urgent or
// À répondre card has an orange button. The header keeps what the notification centre offered: the archived list and
// clearing it, Mark all read, Archive all with its undo, the link to the preferences. The work that runs keeps its group
// at the top. The rows are brokk-notes-model.ts's.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ReactNode, useEffect, useRef, useState } from "react";
import { GoToButton } from "../go-to-button";
import { tCount as translateCount, t as translateNow, useT } from "../i18n/i18n";
import { InlineCodeText } from "../inline-code";
import { MoltenWave } from "../molten-button";
import { RowBoundary, WorkRow } from "../notification-center";
import { MaxRenderedRows, notificationSourceLabel, NotificationSubject, subjectOf } from "../notification-rules";
import { openNotificationSettings } from "../notification-settings";
import { WorkspaceLabel, workspaceLabel } from "../notification-workspace";
import {
    archivedEntries,
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
import { showCountedUndoToast } from "../sidebar/sidebar-undo";
import { DominoLoader } from "../suite/suite";
import { toneOf } from "../toast-model";
import { GhostButton, PrimaryButton, SecondaryButton } from "./boss-card-buttons";
import { HandoffRowView } from "./boss-handoff-row";
import { ToHandleAction, toHandleHeadline, toHandleName } from "./boss-to-handle-model";
import {
    archivePlan,
    cardGoTo,
    cardTarget,
    isPrimaryAction,
    NoteRow,
    rowSourceId,
    sourceBesideWorkspace,
} from "./brokk-notes-model";
import { EmptyLine, HeaderIconButton, PanelFrame, PanelProblem } from "./brokk-panel-frame";
import { goToWorkspace, labelOfRow, WorkspaceTag } from "./brokk-workspace-tag";
import { BrokkActions } from "./use-brokk-actions";

const ArchiveUndoKind = "notifications:archive";

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

// The sources of the rows that are no notification (rowSourceId) have their words here; the others are the centre's.
const ExtraSourceKeys: Record<string, string> = { pr: "notif.source.pr", handoff: "notif.source.handoff" };

function sourceLabel(id: string): string {
    return ExtraSourceKeys[id] != null ? translateNow(ExtraSourceKeys[id]) : notificationSourceLabel(id);
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

// The buttons of a row To handle: its own, in its own order, without Later, which has a place of its own.
function todoButtons(actions: ToHandleAction[]): ToHandleAction[] {
    return actions.filter((action) => action.run.kind !== "later" && action.run.kind !== "ignore");
}

// The Archive of a card (#2195): the one action every card ends its action line with. It shows on hover and on keyboard
// focus, and keeps its place the rest of the time, so that no card is taller or shorter for it.
function ArchiveButton({ onArchive }: { onArchive: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            title={t("notif.center.archive")}
            aria-label={t("notif.center.archive")}
            data-testid="notification-archive"
            onClick={(e) => {
                e.stopPropagation();
                onArchive();
            }}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-11 text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-hover hover:text-primary focus-visible:opacity-100"
        >
            <i className="fa fa-solid fa-box-archive" aria-hidden />
        </button>
    );
}

// The title line every kind of card has (#2195): the agent's name or the event, then its short text, in one weight.
function CardTitle({
    title,
    text,
    lead,
    tail,
    dim,
    testId,
    data,
}: {
    title: ReactNode;
    text?: ReactNode;
    lead?: ReactNode;
    tail?: ReactNode;
    dim?: boolean;
    testId: string;
    data?: Record<string, string>;
}) {
    return (
        <div
            className={cn("mt-brokk-rt flex items-start gap-1.5", dim && "text-secondary")}
            data-testid={testId}
            {...data}
        >
            {lead}
            <span className="line-clamp-3 min-w-0">
                {title}
                {text ? (
                    <>
                        <span className="text-muted" aria-hidden>
                            {" · "}
                        </span>
                        <span className="text-secondary">{text}</span>
                    </>
                ) : null}
            </span>
            {tail}
        </div>
    );
}

// The action line every kind of card has (#2195), in the same place: the card's own actions on the left, then on the
// right what is not its own (Later, Go to →) and Archive. It keeps its height with no action at all.
function ActionLine({
    own,
    extra,
    goTo,
    archive,
}: {
    own?: ReactNode;
    extra?: ReactNode;
    goTo?: ReactNode;
    archive?: ReactNode;
}) {
    return (
        <div className="mt-brokk-ra" data-testid="brokk-card-actions">
            {own}
            <span className="mt-brokk-ra-end">
                {extra}
                {goTo}
                {archive}
            </span>
        </div>
    );
}

function TodoRowBody({ row, actions, onArchive }: { row: NoteRow; actions: BrokkActions; onArchive: () => void }) {
    const t = useT();
    const item = row.item;
    const buttons = todoButtons(item.actions);
    const later = item.actions.find((a) => a.run.kind === "later");
    return (
        <>
            <CardTitle
                title={toHandleHeadline(item)}
                dim={item.seen}
                testId="boss-card-todo-name"
                data={{ "data-line": toHandleName(item) }}
                tail={
                    item.seen ? (
                        <span className="shrink-0 text-11 font-normal text-muted" data-testid="boss-card-todo-seen">
                            {t("boss.todo.seen")}
                        </span>
                    ) : null
                }
            />
            <ActionLine
                own={buttons.map((action, i) => {
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
                extra={
                    later != null ? (
                        <HeaderIconButton
                            icon="clock"
                            label={t("boss.todo.later")}
                            testId="boss-card-todo-later"
                            onClick={() => actions.runTodo(item, later)}
                        />
                    ) : null
                }
                archive={<ArchiveButton onArchive={onArchive} />}
            />
        </>
    );
}

function EntryRowBody({
    row,
    archived,
    running,
    error,
    onAction,
    onOpen,
    onArchive,
    onSilence,
}: {
    row: NoteRow;
    archived: boolean;
    running: Record<string, boolean>;
    error: string;
    onAction: (action: NotificationAction) => void;
    onOpen: () => void;
    onArchive: () => void;
    onSilence: (subject: NotificationSubject) => void;
}) {
    const t = useT();
    const entry = row.entry;
    const actions = displayActions(entry);
    const anyRunning = actions.some((a) => running[`${entry.id}:${a.id}`]);
    const subject = subjectOf(entry.source);
    const silenceable = !archived && entry.kind === "info" && subject != null;
    const tone = toneOf(entry.kind);
    const resolved = entry.resolved != null;
    return (
        <>
            <CardTitle
                testId="notification-title"
                lead={
                    entry.kind === "error" || entry.kind === "warning" ? (
                        <i
                            aria-label={tone.label}
                            className={cn(
                                "fa fa-solid mt-0.5 w-3.5 shrink-0 text-center",
                                `fa-${tone.icon}`,
                                tone.colorClass
                            )}
                        />
                    ) : null
                }
                title={<InlineCodeText text={notificationTitle(entry, t)} />}
                text={entry.message ? <InlineCodeText text={notificationMessage(entry)} /> : null}
                tail={
                    resolved ? (
                        <span className="shrink-0 text-11 font-normal text-muted">✓ {t("notif.center.resolved")}</span>
                    ) : null
                }
            />
            {archived && actions.length === 0 ? null : (
                <ActionLine
                    own={actions.map((action, i) => (
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
                    extra={
                        silenceable ? (
                            <button
                                type="button"
                                data-testid="notification-silence"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSilence(subject);
                                }}
                                className={cn(
                                    GhostButton,
                                    "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                                )}
                            >
                                {t("notif.center.silence")}
                            </button>
                        ) : null
                    }
                    goTo={
                        cardGoTo(row, archived) != null ? (
                            <GoToButton
                                title={t("notif.center.goToTitle")}
                                testId="notification-goto"
                                onClick={onOpen}
                            />
                        ) : null
                    }
                    archive={archived ? null : <ArchiveButton onArchive={onArchive} />}
                />
            )}
            {error ? <div className="mt-1 text-11 text-danger">{error}</div> : null}
        </>
    );
}

// An agent that finished (Fait): no notification of its own, so its card is the agent's name and what it did.
function FinishedRowBody({ row, onOpen, onArchive }: { row: NoteRow; onOpen: () => void; onArchive: () => void }) {
    const t = useT();
    const finished = row.finished;
    return (
        <>
            <CardTitle
                testId="boss-card-info-name"
                title={finished.name}
                text={finished.line.key != null ? t(finished.line.key, finished.line.vars) : ""}
            />
            <ActionLine
                goTo={
                    cardGoTo(row) != null ? (
                        <GoToButton
                            title={t("reviewsAgents.goToTitle", { name: finished.name })}
                            testId="notification-goto"
                            onClick={onOpen}
                        />
                    ) : null
                }
                archive={<ArchiveButton onArchive={onArchive} />}
            />
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
    onArchive,
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
    onArchive: () => void;
    onSilence: (subject: NotificationSubject) => void;
}) {
    const rowRef = useRef<HTMLLIElement>(null);
    useEffect(() => {
        if (highlighted) {
            rowRef.current?.scrollIntoView?.({ block: "nearest" });
        }
    }, [highlighted]);
    const entry = row.entry;
    const hasTarget = cardTarget(row, archived) != null;
    // Delete or Backspace on the card itself archives it, and the focus moves to a neighbour so the keyboard stays in the list.
    const archiveAndKeepFocus = () => {
        const li = rowRef.current;
        const neighbour = li?.nextElementSibling ?? li?.previousElementSibling;
        if (neighbour instanceof HTMLElement) {
            neighbour.focus();
        }
        onArchive();
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
        const action = e.nativeEvent.isComposing
            ? null
            : rowKeyAction(e.key, { onRow: e.target === e.currentTarget, archived, hasOrigin: hasTarget });
        if (action == null) {
            return;
        }
        e.preventDefault();
        if (action === "clear") {
            archiveAndKeepFocus();
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
    const source = sourceBesideWorkspace(label?.name ?? "", sourceLabel(rowSourceId(row)));
    const archiveButton = archived ? null : <ArchiveButton onArchive={onArchive} />;
    return (
        <li
            ref={rowRef}
            data-testid={testId}
            data-priority={row.priority}
            data-highlighted={highlighted || undefined}
            data-cta={hasTarget || undefined}
            {...dataKey}
            className={cn(
                "mt-brokk-row mt-brokk-card group",
                highlighted && "molten-notification-highlight",
                entry?.resolved != null && "opacity-60",
                hasTarget && "cursor-pointer"
            )}
            onClick={hasTarget ? onOpen : undefined}
            onKeyDown={onKeyDown}
            role={hasTarget ? "button" : undefined}
            tabIndex={archived ? undefined : 0}
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
            </div>
            {handoff ? (
                <HandoffRowView item={row.item} busyId={actions.busyId} onRun={actions.runTodo} end={archiveButton} />
            ) : row.source === "todo" ? (
                <TodoRowBody row={row} actions={actions} onArchive={onArchive} />
            ) : row.source === "entry" ? (
                <EntryRowBody
                    row={row}
                    archived={archived}
                    running={running}
                    error={error}
                    onAction={onAction}
                    onOpen={onOpen}
                    onArchive={onArchive}
                    onSilence={onSilence}
                />
            ) : (
                <FinishedRowBody row={row} onOpen={onOpen} onArchive={onArchive} />
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

    // Archives cards, whatever their kind (FR-MC-019, AC15 and AC16; #2195): the undo toast gives back exactly what was
    // archived, a notification and the rows that stand for a fact alike.
    const archiveCards = (cards: NoteRow[]) => {
        if (cards.length === 0) {
            return;
        }
        const undo = actions.archive(archivePlan(cards, entries));
        // Successive archives make one toast that counts them all, and its Undo gives them all back (#2241).
        showCountedUndoToast(
            ArchiveUndoKind,
            cards.length,
            (count) => translateCount("notif.center.archivedCount", count),
            undo
        );
    };
    // Takes the developer to what the card is about; going there settles a notification as FR-MC-019 (#2026) says, and an
    // agent that finished leaves when its pane is seen.
    const openCard = (row: NoteRow) => {
        if (row.entry != null) {
            onLeave();
            fireAndForget(() => model.open(row.entry));
            return;
        }
        const finished = row.finished;
        if (finished == null) {
            return;
        }
        if (finished.sessionid) {
            actions.goToSession(finished.sessionid, row.key);
            return;
        }
        onLeave();
        fireAndForget(() =>
            model.goTo({
                workspaceid: finished.workspaceid || undefined,
                tabid: finished.tabid || undefined,
                blockid: finished.blockid,
            })
        );
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
                        {rows.length > 0 ? (
                            <HeaderIconButton
                                icon="broom"
                                label={t("notif.center.archiveAll")}
                                title={t("notif.center.archiveAllTitle")}
                                testId="notification-archive-all"
                                onClick={() => archiveCards(rows)}
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
                                            onArchive={() => {}}
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
                                        onOpen={() => openCard(row)}
                                        onAction={(action) => {
                                            if (action.kind === "open") {
                                                onLeave();
                                            }
                                            fireAndForget(() => model.runAction(row.entry, action));
                                        }}
                                        onArchive={() => archiveCards([row])}
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
