// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Sessions view's confirmations (FR-SHELL-020): ending one session, ending every session no pane shows. Keep is
// focused, so Enter by habit keeps; Escape keeps too.

import { cn, makeIconClass } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { SegmentedControl } from "../segmented-control";
import { DominoLoader } from "../suite/suite";
import { workspaceShownName } from "../workspace-default-name";
import {
    BulkAction,
    bulkCommandLabel,
    BulkCommands,
    bulkConfirmText,
    BulkItem,
    bulkItems,
    bulkKindLabel,
    BulkOptions,
    BulkResult,
    BulkResultKind,
    bulkSummary,
    busyNote,
    restartModes,
} from "./sessions-bulk";
import {
    agentCell,
    cleanupConfirmText,
    displayFolder,
    DurableSession,
    endConfirmText,
    endRunningNote,
    reasonLabel,
    rowName,
    sessionName,
    sessionWhat,
    updateAllConfirmText,
    updateConfirmText,
} from "./sessions-model";

const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

const PrimaryButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";

function DialogButtons({
    confirm,
    busy,
    onKeep,
    onConfirm,
    keepLabel,
    busyLabel,
    destructive = true,
}: {
    confirm: string;
    busy: boolean;
    onKeep: () => void;
    onConfirm: () => void;
    keepLabel?: string;
    busyLabel?: string;
    destructive?: boolean;
}) {
    const t = useT();
    const keepRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        keepRef.current?.focus();
    }, []);
    return (
        <>
            <button ref={keepRef} type="button" className={PlainButton} onClick={onKeep} disabled={busy}>
                {keepLabel ?? t("sessions.dialog.keepIt")}
            </button>
            <button
                type="button"
                className={destructive ? DangerButton : PrimaryButton}
                onClick={onConfirm}
                disabled={busy}
                aria-busy={busy}
            >
                {busy ? (busyLabel ?? t("sessions.bulk.end.running")) : confirm}
                <MoltenWave />
            </button>
        </>
    );
}

export function EndSessionDialog({
    session,
    home,
    now,
    onKeep,
    onEnd,
}: {
    session: DurableSession;
    home: string;
    now: number;
    onKeep: () => void;
    onEnd: () => Promise<void>;
}) {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const text = endConfirmText(session, home, now);
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onEnd();
        } catch (e) {
            setError(serverErrorText(e));
            setBusy(false);
        }
    };
    return (
        <DialogFrame
            role="molten-session-end"
            onEscape={busy ? undefined : onKeep}
            title={text.title}
            subtitle={text.subtitle}
            buttons={<DialogButtons confirm={text.confirm} busy={busy} onKeep={onKeep} onConfirm={confirm} />}
        >
            {text.warning ? <div className="text-warning">{text.warning}</div> : null}
            {session.command && session.command !== sessionWhat(session) ? (
                <div className="text-secondary">
                    {t("sessions.dialog.running")} <span className="font-mono">{session.command}</span>
                </div>
            ) : null}
            <div className="text-secondary">
                {session.shown ? t("sessions.dialog.paneStays") : t("sessions.dialog.noPane")}
            </div>
            {error ? <div className="text-danger">{error}</div> : null}
        </DialogFrame>
    );
}

// Update the session (#933): the confirmation names it and says what restarts; a busy agent is left to its turn.
export function UpdateSessionDialog({
    session,
    home,
    onKeep,
    onUpdate,
}: {
    session: DurableSession;
    home: string;
    onKeep: () => void;
    onUpdate: () => Promise<void>;
}) {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const text = updateConfirmText(session, home);
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onUpdate();
        } catch (e) {
            setError(serverErrorText(e));
            setBusy(false);
        }
    };
    return (
        <DialogFrame
            role="molten-session-update"
            onEscape={busy ? undefined : onKeep}
            title={text.title}
            subtitle={text.subtitle}
            buttons={
                <DialogButtons
                    confirm={text.confirm}
                    busy={busy}
                    onKeep={onKeep}
                    onConfirm={confirm}
                    busyLabel={t("sessions.updateAll.running")}
                    destructive={false}
                />
            }
        >
            {text.warning ? <div className="text-warning">{text.warning}</div> : null}
            {error ? <div className="text-danger">{error}</div> : null}
        </DialogFrame>
    );
}

// Update all outdated sessions (#933): one confirmation listing them.
export function UpdateAllDialog({
    sessions,
    home,
    onKeep,
    onUpdate,
}: {
    sessions: DurableSession[];
    home: string;
    onKeep: () => void;
    onUpdate: () => Promise<void>;
}) {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const text = updateAllConfirmText(sessions);
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onUpdate();
        } catch (e) {
            setError(serverErrorText(e));
            setBusy(false);
        }
    };
    return (
        <DialogFrame
            role="molten-session-update-all"
            onEscape={busy ? undefined : onKeep}
            title={text.title}
            subtitle={text.subtitle}
            wide
            buttons={
                <DialogButtons
                    confirm={text.confirm}
                    busy={busy}
                    onKeep={onKeep}
                    onConfirm={confirm}
                    keepLabel={t("sessions.dialog.keepThem")}
                    busyLabel={t("sessions.updateAll.running")}
                    destructive={false}
                />
            }
        >
            <ul className="flex flex-col gap-1.5">
                {sessions.map((s) => {
                    const note = busyNote("restart", s);
                    return (
                        <li key={s.id} className="flex min-w-0 flex-col gap-0.5">
                            <div className="flex min-w-0 items-baseline gap-2">
                                <span className="shrink-0 font-medium text-primary">{rowName(s, home)}</span>
                                <span className="min-w-0 truncate text-secondary">{agentCell(s).label}</span>
                            </div>
                            {note ? <div className="text-muted">{note}</div> : null}
                        </li>
                    );
                })}
            </ul>
            {error ? <div className="text-danger">{error}</div> : null}
        </DialogFrame>
    );
}

export function CleanupDialog({
    sessions,
    home,
    onKeep,
    onEnd,
}: {
    sessions: DurableSession[];
    home: string;
    onKeep: () => void;
    onEnd: () => Promise<void>;
}) {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const text = cleanupConfirmText(sessions);
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onEnd();
        } catch (e) {
            setError(serverErrorText(e));
            setBusy(false);
        }
    };
    return (
        <DialogFrame
            role="molten-session-cleanup"
            onEscape={busy ? undefined : onKeep}
            title={text.title}
            subtitle={text.subtitle}
            wide
            buttons={<DialogButtons confirm={text.confirm} busy={busy} onKeep={onKeep} onConfirm={confirm} />}
        >
            <ul className="flex flex-col gap-1.5" aria-label={t("sessions.dialog.toEnd")}>
                {sessions.map((s) => {
                    const folder = displayFolder(s, home);
                    const note = endRunningNote(s);
                    return (
                        <li key={s.id} className="flex min-w-0 flex-col gap-0.5">
                            <div className="flex min-w-0 items-baseline gap-2">
                                <span className="shrink-0 font-medium text-primary">{sessionWhat(s)}</span>
                                {folder ? (
                                    <span className="min-w-0 truncate text-secondary" title={s.folder}>
                                        {folder}
                                    </span>
                                ) : null}
                                <span className="ml-auto shrink-0 text-muted">
                                    {s.connection || t("sessions.local")} · {reasonLabel(s.reason)}
                                </span>
                            </div>
                            {note ? <div className="text-muted">{note}</div> : null}
                        </li>
                    );
                })}
            </ul>
            {error ? <div className="text-danger">{error}</div> : null}
        </DialogFrame>
    );
}

const ResultIcons: Record<BulkResultKind, string> = {
    done: "circle-check",
    skipped: "circle-minus",
    failed: "circle-xmark",
};

const ResultTones: Record<BulkResultKind, string> = {
    done: "text-success",
    skipped: "text-warning",
    failed: "text-error",
};

// The state of a row is told by its icon's shape and its label, never by colour alone (NFR-SHELL-026).
function ResultMark({ result, running }: { result: BulkResult; running: boolean }) {
    const t = useT();
    if (result == null) {
        return running ? (
            <DominoLoader className="mt-dominos-icon text-muted" label={t("sessions.dialog.runningMark")} />
        ) : (
            <i
                className={cn(makeIconClass("circle", true), "w-4 shrink-0 text-11 text-muted opacity-50")}
                aria-label={t("sessions.dialog.waitingMark")}
            />
        );
    }
    return (
        <i
            className={cn(makeIconClass(ResultIcons[result.kind], true), "w-4 shrink-0", ResultTones[result.kind])}
            aria-label={bulkKindLabel(result.kind)}
            title={bulkKindLabel(result.kind)}
        />
    );
}

type BulkPhase = "confirm" | "running" | "results";

function firstPending(items: BulkItem[], results: Record<string, BulkResult>): string {
    return items.find((i) => !i.skip && results[i.session.id] == null)?.session.id ?? null;
}

function ResultsButtons({ onClose }: { onClose: () => void }) {
    const t = useT();
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    return (
        <button ref={ref} type="button" className={PlainButton} onClick={onClose}>
            {t("common.close")}
        </button>
    );
}

// The bulk confirmation (#389), built on the same frame and buttons as the end confirmations: the sessions the action
// reaches and the ones it leaves out with why, its choice (the command, the permission mode), then each session's
// result in place as the run goes. Keep is focused; Escape keeps, and does nothing while the run goes.
export function BulkDialog({
    action,
    sessions,
    home,
    onClose,
    onUnseen,
    run,
}: {
    action: BulkAction;
    sessions: DurableSession[];
    home: string;
    onClose: (results: BulkResult[]) => void;
    onUnseen?: (results: BulkResult[]) => void;
    run: (items: BulkItem[], opts: BulkOptions, onResult: (r: BulkResult) => void) => Promise<BulkResult[]>;
}) {
    const t = useT();
    const [phase, setPhase] = useState<BulkPhase>("confirm");
    const [commandId, setCommandId] = useState<string>(BulkCommands[0]?.id);
    const [mode, setMode] = useState<string>("");
    const [results, setResults] = useState<Record<string, BulkResult>>({});
    const [done, setDone] = useState<BulkResult[]>([]);
    // The list is frozen at the confirmation: a session that ends during the run keeps its row and its result.
    const [frozen, setFrozen] = useState<BulkItem[]>(null);
    const command = action === "send" ? BulkCommands.find((c) => c.id === commandId) : undefined;
    const items = frozen ?? bulkItems(action, sessions, command);
    const text = bulkConfirmText(action, items, command);
    const reachable = items.filter((i) => !i.skip).length;
    const hasClaude = items.some((i) => !i.skip && i.session.agent === "claude");
    const close = () => onClose(done);
    // The dialog can go while its run goes on (the view closes, or every session it lists ended): the run then
    // reports through onUnseen instead (#439).
    const mounted = useRef(true);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        []
    );
    const confirm = async () => {
        setFrozen(items);
        setPhase("running");
        const all = await run(items, { command, mode }, (r) => {
            setResults((prev) => ({ ...prev, [r.id]: r }));
        });
        if (!mounted.current) {
            onUnseen?.(all);
            return;
        }
        setDone(all);
        setPhase("results");
    };
    const summary = phase === "results" ? bulkSummary(action, done) : null;
    const buttons =
        phase === "results" ? (
            <ResultsButtons onClose={close} />
        ) : (
            <DialogButtons
                confirm={text.confirm}
                busy={phase === "running" || reachable === 0}
                busyLabel={phase === "running" ? text.running : text.confirm}
                keepLabel={action === "end" ? t("sessions.dialog.keepThem") : t("common.cancel")}
                destructive={action === "end"}
                onKeep={close}
                onConfirm={() => void confirm()}
            />
        );
    const pending = phase === "running" ? firstPending(items, results) : null;
    return (
        <DialogFrame
            role={`molten-session-bulk-${action}`}
            onEscape={phase === "running" ? undefined : close}
            title={summary ? summary.title : text.title}
            subtitle={summary ? summary.detail || t("sessions.dialog.allDone") : text.subtitle}
            wide
            trapFocus
            buttons={buttons}
        >
            {action === "send" && phase === "confirm" ? (
                <div className="flex flex-col gap-1.5">
                    <span className="text-secondary">{t("sessions.dialog.command")}</span>
                    <SegmentedControl
                        label={t("sessions.dialog.command")}
                        segments={BulkCommands.map((c) => ({
                            value: c.id,
                            label: bulkCommandLabel(c),
                            title: [...new Set(Object.values(c.actions).map((a) => a.command))].join(" · "),
                        }))}
                        selected={commandId}
                        onSelect={setCommandId}
                        className="flex-wrap"
                    />
                </div>
            ) : null}
            {action === "restart" && phase === "confirm" && hasClaude ? (
                <div className="flex flex-col gap-1.5">
                    <span className="text-secondary">{t("sessions.dialog.permissionMode")}</span>
                    <SegmentedControl
                        label={t("sessions.dialog.permissionMode")}
                        segments={restartModes().map((m) => ({ value: m.id || "keep", label: m.label }))}
                        selected={mode || "keep"}
                        onSelect={(v) => setMode(v === "keep" ? "" : v)}
                        className="flex-wrap"
                    />
                    {mode === "bypassPermissions" ? (
                        <span className="text-warning">{t("sessions.dialog.bypassWarning")}</span>
                    ) : null}
                </div>
            ) : null}
            <ul
                className="flex flex-col gap-1.5"
                aria-label={t("sessions.dialog.selected")}
                data-testid="bulk-sessions"
            >
                {items.map((item) => {
                    const s = item.session;
                    const folder = displayFolder(s, home);
                    const result = results[s.id];
                    const note = item.skip ? item.skip : phase === "confirm" ? busyNote(action, s, command) : "";
                    return (
                        <li key={s.id} className="flex min-w-0 flex-col gap-0.5" data-bulk-row={s.id}>
                            <div className="flex min-w-0 items-baseline gap-2">
                                {phase === "confirm" ? (
                                    <i
                                        className={cn(
                                            makeIconClass(item.skip ? "circle-minus" : "circle-check", true),
                                            "w-4 shrink-0",
                                            item.skip ? "text-muted" : "text-secondary"
                                        )}
                                        aria-label={
                                            item.skip ? t("sessions.dialog.leftOut") : t("sessions.dialog.included")
                                        }
                                    />
                                ) : (
                                    <ResultMark result={result} running={pending === s.id} />
                                )}
                                <span className={cn("shrink-0 font-medium", item.skip ? "text-muted" : "text-primary")}>
                                    {sessionName(s, home)}
                                </span>
                                <span className="shrink-0 text-secondary">{agentCell(s).label}</span>
                                {folder ? (
                                    <span
                                        className="min-w-0 truncate font-mono text-11 text-secondary"
                                        title={s.folder}
                                    >
                                        {folder}
                                    </span>
                                ) : null}
                                <span className="ml-auto shrink-0 text-muted">
                                    {workspaceShownName(s.workspacename, t) || t("sessions.notInPaneTitle")}
                                </span>
                            </div>
                            {result ? (
                                <div
                                    className={cn("pl-6", result.kind === "failed" ? "text-danger" : "text-secondary")}
                                    data-bulk-result={result.kind}
                                >
                                    {bulkKindLabel(result.kind)}: {result.message}
                                </div>
                            ) : note ? (
                                <div className="pl-6 text-muted">{note}</div>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </DialogFrame>
    );
}
