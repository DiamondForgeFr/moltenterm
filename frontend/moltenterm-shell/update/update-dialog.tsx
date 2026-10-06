// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold update (#64): a status bar button when a newer gold is delivered, and the dialog that shows what changed,
// what a restart stops, and lets the user choose when.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readableSubject } from "../mission/versions";
import { MoltenWave } from "../molten-button";
import { groupNotes, restartWarning, TerminalSummary, updateLabel } from "./update-model";
import { GoldUpdateModel, readTerminals } from "./update-store";

function NoteList({ title, notes }: { title: string; notes: { sha: string; subject: string }[] }) {
    if (notes.length === 0) {
        return null;
    }
    return (
        <div className="mt-2">
            <div className="mb-0.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</div>
            <ul className="flex flex-col gap-0.5 text-xs">
                {notes.map((n) => {
                    const s = readableSubject(n.subject);
                    return (
                        <li key={n.sha} className="truncate" title={n.subject}>
                            {s.ticket ? <span className="text-muted">#{s.ticket} </span> : null}
                            {s.text}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function UpdateDialog() {
    const model = GoldUpdateModel.getInstance();
    const offer = useAtomValue(model.offerAtom);
    const busy = useAtomValue(model.busyAtom);
    const error = useAtomValue(model.errorAtom);
    const [terminals, setTerminals] = useState<TerminalSummary>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        fireAndForget(async () => setTerminals(await readTerminals()));
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                globalStore.set(model.dialogOpenAtom, false);
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);
    if (offer == null) {
        return null;
    }
    const groups = groupNotes(offer.notes);
    const close = () => globalStore.set(model.dialogOpenAtom, false);
    return createPortal(
        <div className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40" onPointerDown={close}>
            <div
                ref={panelRef}
                onPointerDown={(e) => e.stopPropagation()}
                className="flex max-h-[80vh] w-[520px] flex-col rounded border border-border bg-modalbg shadow-xl"
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-sm font-semibold">A new MoltenTerm gold is ready</div>
                    <div className="text-xs text-muted">
                        {updateLabel(offer)} · built {new Date(offer.builtAt).toLocaleString("en-GB")}
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
                    {offer.notes.length === 0 ? <div className="text-xs text-muted">No change listed.</div> : null}
                    <NoteList title="New" notes={groups.features} />
                    <NoteList title="Fixed" notes={groups.fixes} />
                    <NoteList title="Other changes" notes={groups.other} />
                    <div className="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                        <div className="text-primary">
                            {terminals ? restartWarning(terminals) : "Looking at the open terminals…"}
                        </div>
                        {terminals?.running.length ? (
                            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-secondary">
                                {terminals.running.map((t, i) => (
                                    <li key={i} className="truncate">
                                        {t.workspace}
                                        {t.tab ? ` · ${t.tab}` : ""} — {t.command}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        <div className="mt-1 text-[11px] text-muted">
                            Your configuration, workspaces, layouts and mods are kept.
                        </div>
                    </div>
                    {error ? <div className="mt-2 text-xs text-error">{error}</div> : null}
                </div>
                <div className="flex items-center gap-2 border-t border-border px-4 py-3">
                    <button
                        type="button"
                        onClick={() => model.skip(offer)}
                        className="cursor-pointer rounded px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
                    >
                        Skip this build
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => fireAndForget(() => model.apply(offer, "quit"))}
                            className="cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary"
                        >
                            Update when I quit
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => fireAndForget(() => model.apply(offer, "now"))}
                            className={cn(
                                "molten-btn cursor-pointer rounded px-3 py-1.5 text-xs",
                                busy && "opacity-60"
                            )}
                        >
                            {busy ? "Preparing…" : "Update now"}
                            <MoltenWave />
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
}

// The status bar's update button, and the dialog when it is open.
export function GoldUpdateButton() {
    const model = GoldUpdateModel.getInstance();
    const offer = useAtomValue(model.offerAtom);
    const open = useAtomValue(model.dialogOpenAtom);
    const pendingOnQuit = useAtomValue(model.pendingOnQuitAtom);
    useEffect(() => model.start(), []);
    if (offer == null) {
        return null;
    }
    return (
        <>
            <button
                type="button"
                onClick={() => globalStore.set(model.dialogOpenAtom, true)}
                title={pendingOnQuit ? "Installs when you quit MoltenTerm" : `Update to ${updateLabel(offer)}`}
                className="flex cursor-pointer items-center gap-1 rounded border border-accent/60 px-1.5 leading-[16px] text-primary hover:bg-accent/15"
            >
                <i className="fa fa-solid fa-circle-arrow-up text-[10px] text-accent" />
                {pendingOnQuit ? "Update on quit" : "Update"}
            </button>
            {open ? <UpdateDialog /> : null}
        </>
    );
}
