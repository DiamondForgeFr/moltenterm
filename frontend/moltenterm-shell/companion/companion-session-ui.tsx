// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How the companion lets the user choose another session (DS-SHELL-060): the history list. The session it shows is
// named by the dashboard's hero (companion-hero.tsx).

import { cn } from "@/util/util";
import { useT } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { candidateTitle, CompanionCandidate, historyGroups, relativeTime } from "./companion-model";

export function SessionHistoryList({
    sessions,
    error,
    now,
    onPick,
    onClose,
}: {
    sessions: CompanionCandidate[];
    error: string;
    now: number;
    onPick: (path: string) => void;
    onClose: () => void;
}) {
    const t = useT();
    return (
        <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-4" data-testid="companion-history">
            <div className="flex items-start gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t("companion.history.back")}
                    data-tip={t("companion.history.back")}
                    className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    data-testid="companion-history-back"
                >
                    <i className="fa fa-solid fa-arrow-left" />
                </button>
                <div>
                    <div className="text-13 leading-5 font-medium text-primary">{t("companion.history.title")}</div>
                    <div className="text-12 text-secondary">{t("companion.history.hint")}</div>
                </div>
            </div>
            {sessions == null && error == null ? (
                <div className="text-12 text-muted">
                    <DominoLoader className="mr-1.5" />
                    {t("companion.loading")}
                </div>
            ) : null}
            {sessions != null && sessions.length === 0 ? (
                <div className="text-12 text-muted">{t("companion.history.empty")}</div>
            ) : null}
            {historyGroups(sessions).map((group) => (
                <div
                    key={group.key}
                    className="flex flex-col gap-1.5"
                    data-testid={`companion-history-${group.key}-group`}
                >
                    {group.key === "current" ? null : (
                        <div className="text-11 font-medium text-muted uppercase">{group.label}</div>
                    )}
                    {group.sessions.map((c) => (
                        <HistoryItem key={c.path} c={c} now={now} onPick={onPick} />
                    ))}
                </div>
            ))}
            {error ? <div className="text-12 text-danger">{error}</div> : null}
        </div>
    );
}

function HistoryItem({ c, now, onPick }: { c: CompanionCandidate; now: number; onPick: (path: string) => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={() => onPick(c.path)}
            className={cn(
                "flex cursor-pointer flex-col items-start gap-0.5 rounded-6 border px-3 py-2 text-left hover:bg-hover",
                c.current ? "border-accent/60" : "border-border"
            )}
            data-testid={
                c.current
                    ? "companion-history-current"
                    : c.live
                      ? "companion-history-live"
                      : c.earlier
                        ? "companion-history-earlier"
                        : "companion-history-item"
            }
        >
            <span className="flex w-full items-start gap-2">
                <span className="line-clamp-2 min-w-0 flex-1 text-12 text-primary">{candidateTitle(c)}</span>
                {c.current ? (
                    <span className="shrink-0 rounded-4 bg-accent/15 px-1.5 text-11 font-medium text-accent">
                        {t("companion.history.thisTerminal")}
                    </span>
                ) : null}
            </span>
            <span className="text-11 text-muted">
                {[
                    c.started ? t("companion.history.startedAgo", { ago: relativeTime(c.started, now) }) : "",
                    c.modified ? t("companion.history.updatedAgo", { ago: relativeTime(c.modified, now) }) : "",
                    c.elsewhere ? t("companion.history.elsewhere") : "",
                ]
                    .filter((s) => !!s)
                    .join(" · ")}
            </span>
        </button>
    );
}
