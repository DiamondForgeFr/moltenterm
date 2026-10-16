// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gold update (#64): a status bar button when a newer gold is delivered, and the dialog that shows what changed,
// what a restart stops, and lets the user choose when.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ScrimClass } from "../dialog-frame";
import { getLocale, useT } from "../i18n/i18n";
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
            <div className="mb-0.5 text-11 font-semibold tracking-wide text-muted uppercase">{title}</div>
            <ul className="flex flex-col gap-0.5 text-12">
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
    const t = useT();
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
        <div
            className={cn("fixed inset-0 z-[9600] flex items-center justify-center", ScrimClass)}
            onPointerDown={close}
        >
            <div
                ref={panelRef}
                onPointerDown={(e) => e.stopPropagation()}
                className="flex max-h-[80vh] w-[520px] flex-col rounded-10 border border-border bg-surface-3 shadow-e3"
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-13 leading-5 font-semibold">{t("update.dialog.title")}</div>
                    <div className="text-12 text-muted">
                        {t("update.dialog.built", {
                            label: updateLabel(offer),
                            date: new Date(offer.builtAt).toLocaleString(getLocale()),
                        })}
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
                    {offer.notes.length === 0 ? (
                        <div className="text-12 text-muted">{t("update.dialog.noChange")}</div>
                    ) : null}
                    <NoteList title={t("update.dialog.new")} notes={groups.features} />
                    <NoteList title={t("update.dialog.fixed")} notes={groups.fixes} />
                    <NoteList title={t("update.dialog.other")} notes={groups.other} />
                    <div className="mt-3 rounded-4 border border-warning/40 bg-warning/10 px-3 py-2 text-12">
                        <div className="text-primary">
                            {terminals ? restartWarning(terminals) : t("update.dialog.lookingTerminals")}
                        </div>
                        {terminals?.running.length ? (
                            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-11 text-secondary">
                                {terminals.running.map((term, i) => (
                                    <li key={i} className="truncate">
                                        {term.workspace}
                                        {term.tab ? ` · ${term.tab}` : ""} — {term.command}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        <div className="mt-1 text-11 text-muted">{t("update.dialog.kept")}</div>
                    </div>
                    {error ? <div className="mt-2 text-12 text-danger">{error}</div> : null}
                </div>
                <div className="flex items-center gap-2 border-t border-border px-4 py-3">
                    <button
                        type="button"
                        onClick={() => model.skip(offer)}
                        className="cursor-pointer rounded-6 px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                    >
                        {t("update.dialog.skip")}
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => fireAndForget(() => model.apply(offer, "quit"))}
                            className="cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                        >
                            {t("update.dialog.onQuit")}
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => fireAndForget(() => model.apply(offer, "now"))}
                            className={cn(
                                "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12",
                                busy && "opacity-60"
                            )}
                        >
                            {busy ? t("update.dialog.preparing") : t("update.dialog.now")}
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
    const t = useT();
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
                title={
                    pendingOnQuit
                        ? t("update.button.onQuitTitle")
                        : t("update.button.title", { label: updateLabel(offer) })
                }
                className="flex cursor-pointer items-center gap-1 rounded-6 border border-accent/60 px-1.5 leading-[16px] text-primary hover:bg-accent/15"
            >
                <i className="fa fa-solid fa-circle-arrow-up text-11 text-accent" />
                {pendingOnQuit ? t("update.button.onQuit") : t("update.button.update")}
            </button>
            {open ? <UpdateDialog /> : null}
        </>
    );
}
