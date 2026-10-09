// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Sessions view's confirmations (FR-SHELL-020): ending one session, ending every session no pane shows. Keep is
// focused, so Enter by habit keeps; Escape keeps too.

import { useEffect, useRef, useState } from "react";
import { DialogFrame, useEscape } from "../dialog-frame";
import { MoltenWave } from "../molten-button";
import {
    cleanupConfirmText,
    displayFolder,
    DurableSession,
    endConfirmText,
    reasonLabel,
    sessionWhat,
} from "./sessions-model";

const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

function DialogButtons({
    confirm,
    busy,
    onKeep,
    onConfirm,
}: {
    confirm: string;
    busy: boolean;
    onKeep: () => void;
    onConfirm: () => void;
}) {
    const keepRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        keepRef.current?.focus();
    }, []);
    return (
        <>
            <button ref={keepRef} type="button" className={PlainButton} onClick={onKeep} disabled={busy}>
                Keep it
            </button>
            <button type="button" className={DangerButton} onClick={onConfirm} disabled={busy} aria-busy={busy}>
                {busy ? "Ending…" : confirm}
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
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const text = endConfirmText(session, home, now);
    useEscape(!busy, onKeep);
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onEnd();
        } catch (e) {
            setError(e?.message ?? String(e));
            setBusy(false);
        }
    };
    return (
        <DialogFrame
            role="molten-session-end"
            title={text.title}
            subtitle={text.subtitle}
            buttons={<DialogButtons confirm={text.confirm} busy={busy} onKeep={onKeep} onConfirm={confirm} />}
        >
            {text.warning ? <div className="text-warning">{text.warning}</div> : null}
            {session.command && session.command !== sessionWhat(session) ? (
                <div className="text-secondary">
                    Running: <span className="font-mono">{session.command}</span>
                </div>
            ) : null}
            <div className="text-secondary">
                {session.shown
                    ? "Its pane stays, with the ended shell; close it when you no longer need what it shows."
                    : "It has no pane: what it printed since goes with it."}
            </div>
            {error ? <div className="text-error">{error}</div> : null}
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
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const text = cleanupConfirmText(sessions);
    useEscape(!busy, onKeep);
    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onEnd();
        } catch (e) {
            setError(e?.message ?? String(e));
            setBusy(false);
        }
    };
    return (
        <DialogFrame
            role="molten-session-cleanup"
            title={text.title}
            subtitle={text.subtitle}
            wide
            buttons={<DialogButtons confirm={text.confirm} busy={busy} onKeep={onKeep} onConfirm={confirm} />}
        >
            <ul className="flex flex-col gap-1.5" aria-label="Sessions to end">
                {sessions.map((s) => {
                    const folder = displayFolder(s, home);
                    return (
                        <li key={s.id} className="flex min-w-0 items-baseline gap-2">
                            <span className="shrink-0 font-medium text-primary">{sessionWhat(s)}</span>
                            {folder ? (
                                <span className="min-w-0 truncate text-secondary" title={s.folder}>
                                    {folder}
                                </span>
                            ) : null}
                            <span className="ml-auto shrink-0 text-muted">
                                {s.connection || "local"} · {reasonLabel(s.reason)}
                            </span>
                        </li>
                    );
                })}
            </ul>
            {error ? <div className="text-error">{error}</div> : null}
        </DialogFrame>
    );
}
