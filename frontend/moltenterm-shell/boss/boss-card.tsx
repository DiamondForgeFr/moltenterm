// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Ferrand's Sessions card (FR-BOSS-002, DS-BOSS-002): a layer that floats over the app beside the bubble or the pennant,
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
import { DurableSessions } from "../sessions/sessions-store";
import { DominoLoader } from "../suite/suite";
import { TabActivity, whileShown } from "../tab-activity";
import { goToLocation, homeFolder, locateSession, openSessionsView, startTerminal } from "./boss-card-actions";
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
import { BossBubbleModel } from "./boss-store";
import FerrandPortrait from "./ferrand.svg";

// How often "up 12 min" is read again while the card shows.
const AgeTickMs = 15000;

const ConnDotClasses: Record<string, string> = {
    connected: "bg-success",
    reconnecting: "bg-warning",
    disconnected: "bg-error",
};

const GhostButton =
    "molten-btn-ghost cursor-pointer rounded-6 px-2 py-0.5 text-11 whitespace-nowrap disabled:opacity-50";
const GoButton = cn(GhostButton, "molten-tone-accent");

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
    const rootRef = useRef<HTMLDivElement>(null);
    const [now, setNow] = useState(Date.now());
    const [busyId, setBusyId] = useState<string>(null);
    const [problem, setProblem] = useState("");
    const home = homeFolder();
    const groups = useMemo(
        () => cardGroups(data, workspace?.oid, home, now),
        [data, workspace?.oid, home, now, locale]
    );
    const count = cardRowCount(groups);

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

    const goTo = (row: CardRow) => {
        if (busyId != null || !row.canShow) {
            return;
        }
        setBusyId(row.id);
        setProblem("");
        fireAndForget(async () => {
            try {
                const loc = await locateSession(row.id);
                model.closeCard({ restoreFocus: false });
                goToLocation(loc);
            } catch (e) {
                setProblem(serverErrorText(e));
            } finally {
                setBusyId(null);
            }
        });
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
            rootRef.current?.querySelectorAll<HTMLButtonElement>("button[data-go]:not(:disabled)") ?? []
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
                    <FerrandPortrait />
                </span>
                <h2
                    className="min-w-0 flex-1 truncate text-13 font-semibold text-primary"
                    data-testid="boss-card-title"
                >
                    {t("boss.card.title", { name })}
                </h2>
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
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-1" onKeyDown={onListKeyDown}>
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
                    groups.map((group) => <CardGroupView key={group.id} group={group} busyId={busyId} onGo={goTo} />)
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
