// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// How the companion names the session it shows and lets the user choose another (DS-SHELL-060): the session bar
// (title, start time, how it was linked, history button), the hint of a guessed link, and the history list.

import { cn } from "@/util/util";
import {
    candidateTitle,
    CompanionCandidate,
    CompanionSession,
    CompanionView,
    guessHint,
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
    return (
        <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-4" data-testid="companion-history">
            <div className="flex items-start gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Back to the session"
                    title="Back to the session"
                    className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    data-testid="companion-history-back"
                >
                    <i className="fa fa-solid fa-arrow-left" />
                </button>
                <div>
                    <div className="text-13 leading-5 font-medium text-primary">Sessions of this folder</div>
                    <div className="text-12 text-secondary">
                        Written since this terminal's agent started. Choose the one this terminal runs.
                    </div>
                </div>
            </div>
            {sessions == null && error == null ? <div className="text-12 text-muted">Loading…</div> : null}
            {sessions != null && sessions.length === 0 ? (
                <div className="text-12 text-muted">No session of this folder was written since the agent started.</div>
            ) : null}
            {(sessions ?? []).map((c) => (
                <button
                    key={c.path}
                    type="button"
                    onClick={() => onPick(c.path)}
                    className={cn(
                        "flex cursor-pointer flex-col items-start gap-0.5 rounded-6 border px-3 py-2 text-left hover:bg-hover",
                        c.current ? "border-accent/60" : "border-border"
                    )}
                    data-testid={c.current ? "companion-history-current" : "companion-history-item"}
                >
                    <span className="flex w-full items-start gap-2">
                        <span className="line-clamp-2 min-w-0 flex-1 text-12 text-primary">{candidateTitle(c)}</span>
                        {c.current ? (
                            <span className="shrink-0 rounded-4 bg-accent/15 px-1.5 text-11 font-medium text-accent">
                                This terminal
                            </span>
                        ) : null}
                    </span>
                    <span className="text-11 text-muted">
                        {[
                            c.started ? `started ${relativeTime(c.started, now)}` : "",
                            c.modified ? `updated ${relativeTime(c.modified, now)}` : "",
                            c.elsewhere ? "guessed by another terminal" : "",
                        ]
                            .filter((s) => !!s)
                            .join(" · ")}
                    </span>
                </button>
            ))}
            {error ? <div className="text-12 text-error">{error}</div> : null}
        </div>
    );
}

// The session's name and start time, so the terminal's agent label and this bar can be matched at a glance.
export function SessionBar({ view, onHistory }: { view: CompanionView; onHistory: () => void }) {
    const session = view.session;
    const started = startedLabel(session?.started, Date.now());
    return (
        <div
            className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-11 text-muted"
            title={[session?.path, session?.format].filter((s) => !!s).join("\n")}
            data-testid="companion-session-bar"
        >
            <span className="shrink-0 font-medium text-secondary">{view.agentname}</span>
            <span className="min-w-0 truncate text-primary" data-testid="companion-session-title">
                {sessionTitle(session)}
            </span>
            {started ? <span className="shrink-0">{started}</span> : null}
            <span className={cn("shrink-0", session?.linkedby === "guessed" && "italic")} data-testid="companion-link">
                {linkLabel(session)}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
                {view.ended ? <span className="text-warning">Agent exited · last session</span> : null}
                {view.status === "loading" ? <span>Reading…</span> : null}
                <UsageButton view={view} className="-my-0.5" />
                <button
                    type="button"
                    onClick={onHistory}
                    aria-label="Session history"
                    title="Session history: choose this terminal's session"
                    className="-my-0.5 cursor-pointer rounded-6 px-1 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                    data-testid="companion-history-open"
                >
                    <i className="fa fa-solid fa-clock-rotate-left" />
                </button>
            </div>
        </div>
    );
}

// A guessed session says how it was chosen and offers the history.
export function GuessNotice({ session, onHistory }: { session: CompanionSession; onHistory: () => void }) {
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
                Not this session?
            </button>
        </div>
    );
}
