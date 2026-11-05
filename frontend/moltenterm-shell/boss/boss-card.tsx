// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The foreman's Sessions card (FR-BOSS-002, DS-BOSS-002): a layer that floats over the app beside the bubble or the pennant,
// listing every running session of every workspace with the Sessions view's own data. It is not a panel, a tab or a
// split: it moves and resizes nothing, and hiding it (the bubble again, Escape, a click outside, its close control, Go
// to) leaves the app as it was. It is not modal either: nothing dims, the focus is not held in it, and a press outside
// goes to what it was aimed at.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentStateDotClasses } from "../agent-state-model";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { modalIsOpen } from "../modal-open";
import { MoltenWave } from "../molten-button";
import { MotionClass } from "../molten-motion";
import {
    activeEntries,
    checkClickable,
    checkUnread,
    formatAge,
    MoltentermNotification,
    notificationActionLabel,
    notificationMessage,
    notificationTitle,
    sortNewestFirst,
} from "../notifications-model";
import { MoltentermNotifications } from "../notifications-store";
import { DurableSessions } from "../sessions/sessions-store";
import { DominoLoader } from "../suite/suite";
import { TabActivity, whileShown } from "../tab-activity";
import {
    answerHandoff,
    answerNotice,
    goToLocation,
    homeFolder,
    locateSession,
    openIntegrationPr,
    openNotice,
    openPrPage,
    openSessionsView,
    rerunPrChecks,
    startTerminal,
} from "./boss-card-actions";
import { GhostButton, GoButton, PrimaryButton, SecondaryButton } from "./boss-card-buttons";
import {
    AnchorAttr,
    CardGroup,
    cardGroups,
    cardKeyAction,
    CardKeyInput,
    CardRow,
    cardRowCount,
    CardTestId,
    isOutsidePress,
} from "./boss-card-model";
import { HandoffRowView } from "./boss-handoff-row";
import { BossBubbleModel } from "./boss-store";
import { InfoItem, ToHandleAction, ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import BossPortrait from "./boss-portrait.svg";

// How often "up 12 min" is read again while the card shows.
const AgeTickMs = 15000;

const ConnDotClasses: Record<string, string> = {
    connected: "bg-success",
    reconnecting: "bg-warning",
    disconnected: "bg-error",
};

const ToneDotClasses: Record<string, string> = {
    error: "bg-error",
    waiting: "bg-accent",
    success: "bg-success",
};

const NoticeDotClasses: Record<string, string> = {
    error: "bg-error",
    warning: "bg-accent",
    success: "bg-success",
    info: "bg-secondary",
};

// The card's tabs, in the order they read (FR-BOSS-003 AC1). The card opens on To handle when it counts something, else
// on the tab used last (AC2): this is the last one used, across openings of the card.
export type CardTab = "todo" | "sessions" | "notifications";
export const CardTabs: CardTab[] = ["todo", "sessions", "notifications"];
let lastCardTab: CardTab = "sessions";

function focusIsAtHome(card: HTMLElement): boolean {
    const active = document.activeElement;
    return (
        active == null || active === document.body || card.contains(active) || active.closest(`[${AnchorAttr}]`) != null
    );
}

function CardRowView({ row, busy, onGo }: { row: CardRow; busy: boolean; onGo: (row: CardRow) => void }) {
    const t = useT();
    const goLabel = row.shown ? t("boss.card.goTo") : t("boss.card.showIt");
    const goName = row.shown
        ? t("boss.card.goToName", { name: row.name })
        : t("boss.card.showItName", { name: row.name });
    return (
        <li
            className="flex items-start gap-2 rounded-4 py-1.5 pr-2 hover:bg-hover"
            style={{ paddingLeft: 12 + row.depth * 14 }}
            data-testid="boss-card-row"
            data-session={row.id}
        >
            <span className="mt-[5px] flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
                {row.kind === "agent" ? (
                    <span
                        className={cn(
                            "inline-block h-2 w-2 rounded-full",
                            AgentStateDotClasses[row.state] ?? AgentStateDotClasses.idle
                        )}
                        data-state={row.state}
                    />
                ) : (
                    <i className={cn(makeIconClass("terminal", true), "text-10 text-muted")} />
                )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="min-w-0 truncate text-12 font-medium text-primary" data-testid="boss-card-name">
                        {row.name}
                    </span>
                    <span
                        className={cn(
                            "shrink-0 text-11",
                            row.kind === "agent" ? "text-secondary" : "font-mono text-muted"
                        )}
                        data-testid="boss-card-state"
                    >
                        {row.stateText}
                    </span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-11 text-muted">
                    {row.project ? (
                        <span className="min-w-0 truncate text-secondary" data-testid="boss-card-project">
                            {row.project}
                        </span>
                    ) : null}
                    {row.branch ? (
                        <span
                            className="inline-flex min-w-0 items-center gap-1 font-mono"
                            data-testid="boss-card-branch"
                        >
                            <i className={cn(makeIconClass("code-branch", true), "shrink-0 text-10")} aria-hidden />
                            <span className="truncate">{row.branch}</span>
                        </span>
                    ) : null}
                    {row.up ? (
                        <span className="shrink-0 whitespace-nowrap" data-testid="boss-card-up">
                            {t("sessions.up", { age: row.up })}
                        </span>
                    ) : null}
                    {row.host ? (
                        <span
                            className="inline-flex max-w-[10rem] min-w-0 items-center gap-1 rounded-4 border border-border px-1.5 leading-[16px]"
                            title={row.hostTitle}
                            data-testid="boss-card-host"
                        >
                            <span
                                className={cn(
                                    "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                                    ConnDotClasses[row.hostState]
                                )}
                                aria-hidden
                            />
                            <span className="truncate">{row.host}</span>
                        </span>
                    ) : null}
                </div>
            </div>
            <button
                type="button"
                className={GoButton}
                disabled={busy || !row.canShow}
                title={row.canShow ? undefined : row.blockedTitle}
                aria-label={goName}
                data-testid="boss-card-go"
                data-go
                onClick={() => onGo(row)}
            >
                {busy ? <DominoLoader className="mr-1" /> : null}
                {goLabel}
            </button>
        </li>
    );
}

function CardGroupView({ group, busyId, onGo }: { group: CardGroup; busyId: string; onGo: (row: CardRow) => void }) {
    const t = useT();
    return (
        <section aria-label={group.title} data-testid="boss-card-group" data-group={group.id}>
            <div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1">
                {group.unplaced ? (
                    <i className={cn(makeIconClass("link-slash", true), "text-11 text-warning")} aria-hidden />
                ) : (
                    <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-4"
                        style={{ background: group.color || "var(--border-color)" }}
                        aria-hidden
                    />
                )}
                <span className="min-w-0 truncate text-12 font-semibold text-primary">{group.title}</span>
                <span className="shrink-0 rounded-4 bg-surface-2 px-1.5 text-11 leading-[16px] text-secondary">
                    {group.rows.length}
                </span>
                {group.current ? (
                    <span className="shrink-0 rounded-4 bg-accent/15 px-1.5 text-11 leading-[16px] text-accent">
                        {t("sessions.view.thisWorkspace")}
                    </span>
                ) : null}
            </div>
            <ul className="flex flex-col px-1">
                {group.rows.map((row) => (
                    <CardRowView key={row.id} row={row} busy={busyId === row.id} onGo={onGo} />
                ))}
            </ul>
        </section>
    );
}

// One button of a To handle row. The notification's own buttons carry their label; the others take a key.
function ToHandleButton({
    item,
    action,
    busy,
    onRun,
}: {
    item: ToHandleItem;
    action: ToHandleAction;
    busy: boolean;
    onRun: (item: ToHandleItem, action: ToHandleAction) => void;
}) {
    const t = useT();
    const label =
        action.run.kind === "answer"
            ? notificationActionLabel(action.run.action)
            : t(action.labelKey, action.labelVars);
    const style = action.run.kind === "later" ? GhostButton : action.primary ? PrimaryButton : SecondaryButton;
    return (
        <button
            type="button"
            className={style}
            disabled={busy || action.disabled}
            data-testid="boss-card-todo-action"
            data-act={action.id}
            data-kind={action.run.kind}
            data-primary={action.primary ? "true" : "false"}
            onClick={() => onRun(item, action)}
        >
            {busy ? <DominoLoader className="mr-1" /> : null}
            {label}
            {action.primary ? <MoltenWave /> : null}
        </button>
    );
}

function ToHandleRowView({
    item,
    now,
    busyId,
    onRun,
}: {
    item: ToHandleItem;
    now: number;
    busyId: string;
    onRun: (item: ToHandleItem, action: ToHandleAction) => void;
}) {
    const t = useT();
    const notice = item.notice;
    const name = item.name !== "" ? item.name : notice != null ? notificationTitle(notice) : "";
    const line =
        item.lineFromNotice && notice != null
            ? notificationMessage(notice)
            : item.line.key != null
              ? t(item.line.key, item.line.vars)
              : (item.line.text ?? "");
    return (
        <li
            className="flex items-start gap-2 rounded-4 px-3 py-2 hover:bg-hover"
            data-testid="boss-card-todo-row"
            data-todo={item.key}
            data-tone={item.tone}
        >
            <span
                className={cn("mt-[6px] inline-block h-2 w-2 shrink-0 rounded-full", ToneDotClasses[item.tone])}
                aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-baseline gap-1.5">
                    <span
                        className="min-w-0 truncate text-12 font-medium text-primary"
                        data-testid="boss-card-todo-name"
                    >
                        {name}
                    </span>
                    {item.place ? <span className="min-w-0 truncate text-11 text-secondary">{item.place}</span> : null}
                    {item.since > 0 ? (
                        <span className="ml-auto shrink-0 text-11 whitespace-nowrap text-muted">
                            {formatAge(item.since, now)}
                        </span>
                    ) : null}
                </div>
                <div className="text-11 break-words text-secondary" data-testid="boss-card-todo-line">
                    {line}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {item.actions.map((action) => (
                        <ToHandleButton
                            key={action.id}
                            item={item}
                            action={action}
                            busy={busyId === `${item.key}|${action.id}`}
                            onRun={onRun}
                        />
                    ))}
                    {/* The reserved place of B4's "Talk ‹" and "Ask {name} ‹" (FR-BOSS-003): empty until B4 ships. */}
                    <span data-slot="talk" className="contents" aria-hidden />
                </div>
            </div>
        </li>
    );
}

function InfoRowView({ info }: { info: InfoItem }) {
    const t = useT();
    return (
        <li
            className="flex items-start gap-2 rounded-4 px-3 py-1.5"
            data-testid="boss-card-info-row"
            data-info={info.key}
        >
            <span
                className={cn("mt-[6px] inline-block h-2 w-2 shrink-0 rounded-full", NoticeDotClasses.info)}
                aria-hidden
            />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="min-w-0 truncate text-12 text-primary">{info.name}</span>
                {info.place ? <span className="min-w-0 truncate text-11 text-secondary">{info.place}</span> : null}
                <span className="min-w-0 truncate text-11 text-muted">
                    {info.line.key != null ? t(info.line.key, info.line.vars) : ""}
                </span>
            </div>
        </li>
    );
}

function ToHandleView({
    list,
    now,
    busyId,
    onRun,
}: {
    list: ToHandleList;
    now: number;
    busyId: string;
    onRun: (item: ToHandleItem, action: ToHandleAction) => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const handoffs = list.items.filter((item) => item.handoff != null);
    const others = list.items.filter((item) => item.handoff == null);
    return (
        <div className="flex flex-col pb-1">
            {list.items.length === 0 ? (
                <div className="px-3 py-3 text-12 text-secondary" data-testid="boss-card-todo-empty">
                    {t("boss.todo.empty")}
                </div>
            ) : null}
            {handoffs.length > 0 ? (
                <section aria-label={t("boss.todo.handoff.group")} data-testid="boss-card-todo-handoffs">
                    <div className="px-3 pt-2 pb-1 text-11 tracking-wide text-muted uppercase">
                        {t("boss.todo.handoff.group")}
                    </div>
                    <ul className="flex flex-col px-1" data-testid="boss-card-todo-handoff-list">
                        {handoffs.map((item) => (
                            <HandoffRowView key={item.key} item={item} now={now} busyId={busyId} onRun={onRun} />
                        ))}
                    </ul>
                </section>
            ) : null}
            {others.length > 0 ? (
                <section aria-label={handoffs.length > 0 ? t("boss.todo.others") : undefined}>
                    {handoffs.length > 0 ? (
                        <div className="px-3 pt-2 pb-1 text-11 tracking-wide text-muted uppercase">
                            {t("boss.todo.others")}
                        </div>
                    ) : null}
                    <ul className="flex flex-col px-1" data-testid="boss-card-todo-list">
                        {others.map((item) => (
                            <ToHandleRowView key={item.key} item={item} now={now} busyId={busyId} onRun={onRun} />
                        ))}
                    </ul>
                </section>
            ) : null}
            {list.parked > 0 ? (
                <div className="px-3 pt-1 text-11 text-muted" data-testid="boss-card-todo-parked">
                    {tCount("boss.todo.parked", list.parked)}
                </div>
            ) : null}
            {list.info.length > 0 ? (
                <section aria-label={t("boss.todo.forInfo")} data-testid="boss-card-todo-info">
                    <div className="px-3 pt-2 pb-1 text-11 tracking-wide text-muted uppercase">
                        {t("boss.todo.forInfo")}
                    </div>
                    <ul className="flex flex-col px-1">
                        {list.info.map((info) => (
                            <InfoRowView key={info.key} info={info} />
                        ))}
                    </ul>
                </section>
            ) : null}
        </div>
    );
}

// The bell's notifications, read and archived here as there (FR-MC-019, AC5). Nothing opens by itself.
function NotificationsView({
    entries,
    now,
    onOpen,
    onRead,
    onArchive,
}: {
    entries: MoltentermNotification[];
    now: number;
    onOpen: (entry: MoltentermNotification) => void;
    onRead: (entry: MoltentermNotification) => void;
    onArchive: (entry: MoltentermNotification) => void;
}) {
    const t = useT();
    if (entries.length === 0) {
        return (
            <div className="px-3 py-3 text-12 text-secondary" data-testid="boss-card-notif-empty">
                {t("notif.center.empty")}
            </div>
        );
    }
    return (
        <ul className="flex flex-col px-1 pb-1" data-testid="boss-card-notif-list">
            {entries.map((entry) => {
                const unread = checkUnread(entry);
                return (
                    <li
                        key={entry.id}
                        className="flex items-start gap-2 rounded-4 px-3 py-2 hover:bg-hover"
                        data-testid="boss-card-notif-row"
                        data-notif={entry.id}
                    >
                        <span
                            className={cn(
                                "mt-[6px] inline-block h-2 w-2 shrink-0 rounded-full",
                                NoticeDotClasses[entry.kind] ?? NoticeDotClasses.info
                            )}
                            aria-hidden
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex min-w-0 items-baseline gap-1.5">
                                <span
                                    className={cn(
                                        "min-w-0 truncate text-12",
                                        unread ? "font-semibold text-primary" : "text-secondary"
                                    )}
                                >
                                    {notificationTitle(entry)}
                                </span>
                                <span className="ml-auto shrink-0 text-11 whitespace-nowrap text-muted">
                                    {formatAge(entry.updated ?? entry.time, now)}
                                </span>
                            </div>
                            <div className="text-11 break-words text-secondary">{notificationMessage(entry)}</div>
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                {checkClickable(entry) ? (
                                    <button
                                        type="button"
                                        className={SecondaryButton}
                                        data-testid="boss-card-notif-open"
                                        onClick={() => onOpen(entry)}
                                    >
                                        {t("boss.todo.open")}
                                    </button>
                                ) : null}
                                {unread ? (
                                    <button
                                        type="button"
                                        className={GhostButton}
                                        data-testid="boss-card-notif-read"
                                        onClick={() => onRead(entry)}
                                    >
                                        {t("boss.card.markRead")}
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    className={GhostButton}
                                    aria-label={t("notif.center.archiveOne")}
                                    data-testid="boss-card-notif-archive"
                                    onClick={() => onArchive(entry)}
                                >
                                    {t("boss.card.archive")}
                                </button>
                            </div>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}

export function BossCard({ style }: { style: React.CSSProperties }) {
    const t = useT();
    const tCount = useTCount();
    const locale = useLocale();
    const model = BossBubbleModel.getInstance();
    const name = useAtomValue(model.nameAtom, { store: globalStore });
    const collapsed = useAtomValue(model.collapsedAtom, { store: globalStore });
    const badge = useAtomValue(model.badgeAtom, { store: globalStore });
    const data = useAtomValue(DurableSessions.getInstance().dataAtom, { store: globalStore });
    const workspace = useAtomValue(atoms.workspace, { store: globalStore });
    const toHandle = useAtomValue(model.toHandleAtom, { store: globalStore });
    const shownNotices = useAtomValue(MoltentermNotifications.getInstance().shownEntriesAtom, { store: globalStore });
    const rootRef = useRef<HTMLDivElement>(null);
    const [now, setNow] = useState(Date.now());
    const [busyId, setBusyId] = useState<string>(null);
    const [problem, setProblem] = useState("");
    const [tab, setTab] = useState<CardTab>(() => (badge.count > 0 ? "todo" : lastCardTab));
    const home = homeFolder();
    const groups = useMemo(
        () => cardGroups(data, workspace?.oid, home, now),
        [data, workspace?.oid, home, now, locale]
    );
    const count = cardRowCount(groups);
    const notices = useMemo(() => sortNewestFirst(activeEntries(shownNotices ?? [])), [shownNotices]);
    const counts: Record<CardTab, number> = {
        todo: toHandle.items.length,
        sessions: count,
        notifications: notices.length,
    };
    useEffect(() => {
        lastCardTab = tab;
    }, [tab]);

    // The developer asked for the card, so the focus comes into it.
    useEffect(() => {
        rootRef.current?.focus({ preventScroll: true });
    }, []);
    useEffect(() => TabActivity.getInstance().every(whileShown(AgeTickMs), () => setNow(Date.now()), "clock"), []);
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (isOutsidePress(e.target as Element, rootRef.current)) {
                model.closeCard();
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            const card = rootRef.current;
            if (card == null || e.isComposing || modalIsOpen() || modalsModel.hasOpenModals()) {
                return;
            }
            const input: CardKeyInput = { key: e.key, focusAtHome: focusIsAtHome(card) };
            const action = cardKeyAction(input);
            if (!action.hide) {
                return;
            }
            if (action.consume) {
                e.preventDefault();
                e.stopPropagation();
            }
            model.closeCard();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [model]);

    const goToSession = (sessionId: string, busyKey: string) => {
        if (busyId != null) {
            return;
        }
        setBusyId(busyKey);
        setProblem("");
        fireAndForget(async () => {
            try {
                const loc = await locateSession(sessionId);
                model.closeCard({ restoreFocus: false });
                goToLocation(loc);
            } catch (e) {
                setProblem(serverErrorText(e));
            } finally {
                setBusyId(null);
            }
        });
    };
    const goTo = (row: CardRow) => {
        if (!row.canShow) {
            return;
        }
        goToSession(row.id, row.id);
    };
    // A To handle button runs the door it names; a row leaves the list once the fact it shows is gone, never by a click.
    const runTodo = (item: ToHandleItem, action: ToHandleAction) => {
        const run = action.run;
        const busyKey = `${item.key}|${action.id}`;
        if (run.kind === "later") {
            model.park(item.key);
            return;
        }
        if (run.kind === "goto") {
            if (action.disabled) {
                return;
            }
            goToSession(run.sessionId, busyKey);
            return;
        }
        if (run.kind === "integration") {
            model.closeCard({ restoreFocus: false });
            fireAndForget(() => openIntegrationPr(run.dir, run.number));
            return;
        }
        if (run.kind === "external") {
            fireAndForget(() => openPrPage(run.url));
            return;
        }
        if (run.kind === "open") {
            model.closeCard({ restoreFocus: false });
            fireAndForget(() => openNotice(run.entry));
            return;
        }
        if (run.kind === "brief") {
            return;
        }
        const work =
            run.kind === "rerun"
                ? () => rerunPrChecks(run.dir, run.number)
                : run.kind === "handoff"
                  ? () => answerHandoff(run.requestid, run.decision)
                  : () => answerNotice(run.entry, run.action);
        setBusyId(busyKey);
        setProblem("");
        fireAndForget(async () => {
            try {
                await work();
            } catch (e) {
                setProblem(serverErrorText(e));
            } finally {
                setBusyId(null);
            }
        });
    };
    const onTabKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") {
            return;
        }
        e.preventDefault();
        const at = CardTabs.indexOf(tab);
        const next = CardTabs[(at + (e.key === "ArrowRight" ? 1 : CardTabs.length - 1)) % CardTabs.length];
        setTab(next);
        rootRef.current?.querySelector<HTMLElement>(`[data-tab-id="${next}"]`)?.focus();
    };
    const noticeOpen = (entry: MoltentermNotification) => {
        model.closeCard({ restoreFocus: false });
        fireAndForget(() => openNotice(entry));
    };
    const noticeRead = (entry: MoltentermNotification) => {
        MoltentermNotifications.getInstance().markRead([entry.id]);
    };
    const noticeArchive = (entry: MoltentermNotification) => {
        MoltentermNotifications.getInstance().archive([entry.id]);
    };
    const openFullView = () => {
        model.closeCard({ restoreFocus: false });
        fireAndForget(() => openSessionsView());
    };
    const newTerminal = () => {
        model.closeCard({ restoreFocus: false });
        fireAndForget(() => startTerminal());
    };

    // Up and Down walk the Go to buttons, as the Sessions view's keys walk its rows.
    const onListKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
            return;
        }
        const buttons = Array.from(
            rootRef.current?.querySelectorAll<HTMLButtonElement>(
                "button[data-go]:not(:disabled), button[data-act]:not(:disabled), button[data-notif-action]:not(:disabled)"
            ) ?? []
        );
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) {
            return;
        }
        e.preventDefault();
        buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    };

    return (
        <div
            ref={rootRef}
            role="dialog"
            aria-modal="false"
            aria-label={t("boss.card.ariaLabel", { name })}
            tabIndex={-1}
            data-boss-card=""
            data-testid={CardTestId}
            className={cn(
                "mt-boss-card rounded-4 border border-line-strong bg-surface-3 shadow-e2",
                MotionClass.arrive
            )}
            style={style}
        >
            <div className="flex shrink-0 items-center gap-2 border-b border-line-strong px-3 py-2">
                <span className="mt-boss-card-face" aria-hidden>
                    <BossPortrait />
                </span>
                <h2
                    className="min-w-0 flex-1 truncate text-13 font-semibold text-primary"
                    data-testid="boss-card-title"
                >
                    {t("boss.card.title", { name })}
                </h2>
                {/* The reserved place of B4's "Talk ‹" (FR-BOSS-003): empty until B4 ships. */}
                <span data-slot="talk" className="contents" aria-hidden />
                {badge.count > 0 ? (
                    <span className="mt-boss-card-count" data-tone={badge.tone} data-testid="boss-card-count">
                        {tCount("boss.card.waiting", badge.count)}
                    </span>
                ) : null}
                {collapsed ? (
                    <button
                        type="button"
                        className={GhostButton}
                        data-testid="boss-card-show-bubble"
                        onClick={() => model.expand()}
                    >
                        {t("boss.menu.showBubble")}
                    </button>
                ) : null}
                <button
                    type="button"
                    className="molten-btn-ghost flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-12"
                    aria-label={t("common.close")}
                    title={t("common.close")}
                    data-testid="boss-card-close"
                    onClick={() => model.closeCard()}
                >
                    <i className={makeIconClass("xmark", true)} aria-hidden />
                </button>
            </div>
            <div
                className="flex shrink-0 items-end gap-1 border-b border-line-strong px-2"
                role="tablist"
                aria-label={t("boss.card.tablist", { name })}
                onKeyDown={onTabKeyDown}
                data-testid="boss-card-tabs"
            >
                {CardTabs.map((id) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        id={`boss-card-tab-${id}`}
                        aria-selected={tab === id}
                        aria-controls={`boss-card-panel-${id}`}
                        tabIndex={tab === id ? 0 : -1}
                        data-tab-id={id}
                        data-testid={`boss-card-tab-${id}`}
                        className={cn(
                            "-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-2 py-1.5 text-12 whitespace-nowrap",
                            tab === id
                                ? "border-accent font-medium text-primary"
                                : "border-transparent text-secondary hover:text-primary"
                        )}
                        onClick={() => setTab(id)}
                    >
                        {t(`boss.card.tabs.${id}`)}
                        <span
                            className="rounded-4 bg-surface-2 px-1.5 text-11 leading-[16px] text-secondary"
                            data-testid={`boss-card-tab-count-${id}`}
                        >
                            {counts[id]}
                        </span>
                    </button>
                ))}
            </div>
            <div
                role="tabpanel"
                id={`boss-card-panel-${tab}`}
                aria-labelledby={`boss-card-tab-${tab}`}
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-1"
                onKeyDown={onListKeyDown}
            >
                {tab === "todo" ? (
                    <ToHandleView list={toHandle} now={now} busyId={busyId} onRun={runTodo} />
                ) : tab === "notifications" ? (
                    <NotificationsView
                        entries={notices}
                        now={now}
                        onOpen={noticeOpen}
                        onRead={noticeRead}
                        onArchive={noticeArchive}
                    />
                ) : (
                    <>
                        {data == null ? (
                            <div
                                className="flex items-center gap-2 px-3 py-3 text-12 text-secondary"
                                data-testid="boss-card-loading"
                            >
                                <DominoLoader />
                                {t("sessions.view.loading")}
                            </div>
                        ) : count === 0 ? (
                            <div className="flex flex-col items-start gap-2.5 px-3 py-3" data-testid="boss-card-empty">
                                <div className="text-12 text-secondary">{t("boss.card.empty")}</div>
                                <button
                                    type="button"
                                    className="molten-btn inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 px-3 text-12 font-medium"
                                    data-testid="boss-card-new-terminal"
                                    onClick={newTerminal}
                                >
                                    {t("boss.card.newTerminal")}
                                    <MoltenWave />
                                </button>
                            </div>
                        ) : (
                            groups.map((group) => (
                                <CardGroupView key={group.id} group={group} busyId={busyId} onGo={goTo} />
                            ))
                        )}
                    </>
                )}
            </div>
            {problem ? (
                <div className="shrink-0 truncate px-3 py-1 text-11 text-danger" role="status" title={problem}>
                    {problem}
                </div>
            ) : null}
            <div className="flex shrink-0 items-center justify-end border-t border-line-strong px-3 py-2">
                <button
                    type="button"
                    className="molten-btn-secondary inline-flex cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-1 text-12 whitespace-nowrap"
                    data-testid="boss-card-open-sessions"
                    onClick={openFullView}
                >
                    <i className={cn(makeIconClass("layer-group", true), "text-11")} aria-hidden />
                    {t("boss.card.openSessions")}
                </button>
            </div>
        </div>
    );
}
