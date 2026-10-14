// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How the companion names the session it shows and lets the user choose another (DS-SHELL-060): the session bar
// (title, start time, how it was linked, history button), the hint of a guessed link, and the history list.

import { cn } from "@/util/util";
import { useT } from "../i18n/i18n";
import { IntegratedBadge } from "./companion-integration";
import {
    candidateTitle,
    CompanionCandidate,
    CompanionSession,
    CompanionView,
    guessHint,
    historyGroups,
    isIntegrated,
    linkLabel,
    relativeTime,
    sessionTitle,
    startedLabel,
} from "./companion-model";
import { UsageButton } from "./companion-usage";

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
                    title={t("companion.history.back")}
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
                <div className="text-12 text-muted">{t("companion.loading")}</div>
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
            {error ? <div className="text-12 text-error">{error}</div> : null}
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

// The session's name and start time, so the terminal's agent label and this bar can be matched at a glance.
export function SessionBar({
    view,
    name,
    modelEffort,
    onHistory,
    onIntegration,
    onBackToCurrent,
}: {
    view: CompanionView;
    // name: the agent's label, with the session's first name ("[Jérôme] Claude Code", FR-CONT-014).
    name?: string;
    // The agent's model and effort as it reported them ("Opus · high", #549).
    modelEffort?: string;
    onHistory: () => void;
    onIntegration?: () => void;
    // Leaves an earlier session the user chose for the one the agent runs (#600).
    onBackToCurrent?: () => void;
}) {
    const t = useT();
    const session = view.session;
    const started = startedLabel(session?.started, Date.now());
    const earlierCount = view.earlier?.length ?? 0;
    return (
        <div
            className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-11 text-muted"
            title={[session?.path, session?.format].filter((s) => !!s).join("\n")}
            data-testid="companion-session-bar"
        >
            <span className="shrink-0 font-medium text-secondary">{name || view.agentname}</span>
            {modelEffort ? (
                <span className="shrink-0" data-testid="companion-model-effort">
                    {modelEffort}
                </span>
            ) : null}
            <span className="min-w-0 truncate text-primary" data-testid="companion-session-title">
                {sessionTitle(session)}
            </span>
            {started ? <span className="shrink-0">{started}</span> : null}
            <span className={cn("shrink-0", session?.linkedby === "guessed" && "italic")} data-testid="companion-link">
                {linkLabel(session)}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
                {session?.earlier ? (
                    <span className="flex items-center gap-1.5" data-testid="companion-earlier">
                        <span className="rounded-4 border border-border px-1.5 text-secondary">
                            {t("companion.bar.earlierSession")}
                        </span>
                        {onBackToCurrent != null ? (
                            <button
                                type="button"
                                onClick={onBackToCurrent}
                                className="cursor-pointer text-accent hover:underline"
                                data-testid="companion-back-to-current"
                            >
                                {t("companion.bar.backToCurrent")}
                            </button>
                        ) : null}
                    </span>
                ) : null}
                {view.ended ? <span className="text-warning">{t("companion.bar.ended")}</span> : null}
                {view.status === "loading" ? <span>{t("companion.bar.reading")}</span> : null}
                {onIntegration != null && isIntegrated(view) ? (
                    <IntegratedBadge onOpen={onIntegration} className="-my-0.5" />
                ) : null}
                <UsageButton view={view} className="-my-0.5" />
                <button
                    type="button"
                    onClick={onHistory}
                    aria-label={t("companion.bar.history")}
                    title={
                        earlierCount > 0
                            ? t(
                                  earlierCount === 1
                                      ? "companion.bar.historyEarlierOne"
                                      : "companion.bar.historyEarlierOther",
                                  {
                                      count: earlierCount,
                                  }
                              )
                            : t("companion.bar.historyChoose")
                    }
                    className="-my-0.5 flex cursor-pointer items-center gap-1 rounded-6 px-1 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                    data-testid="companion-history-open"
                >
                    <i className="fa fa-solid fa-clock-rotate-left" />
                    {earlierCount > 0 ? (
                        <span className="text-11 tabular-nums" data-testid="companion-earlier-count">
                            {earlierCount}
                        </span>
                    ) : null}
                </button>
            </div>
        </div>
    );
}

// A guessed session says how it was chosen and offers the history.
export function GuessNotice({ session, onHistory }: { session: CompanionSession; onHistory: () => void }) {
    const t = useT();
    const hint = guessHint(session);
    if (hint == null) {
        return null;
    }
    return (
        <div className="mx-3 mt-1.5 flex items-center gap-2 text-11 text-muted" data-testid="companion-guess">
            <span className="min-w-0 truncate">{hint}</span>
            <button
                type="button"
                onClick={onHistory}
                className="shrink-0 cursor-pointer text-accent hover:underline"
                data-testid="companion-guess-change"
            >
                {t("companion.guess.notThis")}
            </button>
        </div>
    );
}
