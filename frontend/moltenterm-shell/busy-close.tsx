// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The confirmation a close shows when it would stop what runs in a terminal (FR-SHELL-061, DS-SHELL-108): one dialog
// per action, the running list (agents first, with their state in words, then commands, each with its workspace and
// tab), Cancel focused so Enter and Escape keep everything, Close anyway as the destructive answer. The worktree, reset
// and Sessions dialogs show the same list inside themselves rather than a second dialog.

import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { cn, makeIconClass, NullAtom } from "@/util/util";
import { Atom, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { AgentStateDotClasses } from "./agent-state-model";
import {
    busyCloseText,
    keptHeading,
    RunningItem,
    runningPlace,
    runningStateText,
    visibleRunning,
} from "./busy-close-model";
import { BusyCloseRequest, BusyCloseRequestAtom } from "./busy-close-store";
import { DialogFrame, useEscape } from "./dialog-frame";
import { useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";
import { workspaceShownName } from "./workspace-default-name";

export const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

function RunningRow({ item }: { item: RunningItem }) {
    const place = runningPlace(item);
    const state = runningStateText(item);
    return (
        <li className="flex min-h-7 min-w-0 items-center gap-2" data-running-kind={item.kind} data-block={item.blockId}>
            {item.kind === "agent" ? (
                <span
                    className={cn(
                        "inline-block h-2 w-2 shrink-0 rounded-full",
                        AgentStateDotClasses[item.state] ?? AgentStateDotClasses.idle
                    )}
                    aria-hidden
                />
            ) : (
                <i className={cn(makeIconClass("terminal", true), "w-3 shrink-0 text-11 text-muted")} aria-hidden />
            )}
            {item.kind === "agent" ? (
                <span className="shrink-0 font-semibold text-primary">{item.label}</span>
            ) : (
                <span className="min-w-0 truncate font-mono text-11 text-primary" title={item.label}>
                    {item.label}
                </span>
            )}
            <span className="shrink-0 text-secondary">{state}</span>
            {place ? (
                <span className="ml-auto min-w-0 shrink truncate pl-2 text-11 text-muted" title={place}>
                    {place}
                </span>
            ) : null}
        </li>
    );
}

// The running list, also shown inside the worktree, reset and tab dialogs.
export function RunningList({ items, heading }: { items: RunningItem[]; heading?: string }) {
    const t = useT();
    if (items == null || items.length === 0) {
        return null;
    }
    const { shown, more } = visibleRunning(items);
    return (
        <div className="flex flex-col gap-1" data-role="molten-running-list">
            {heading ? <div className="text-secondary">{heading}</div> : null}
            <ul className="flex flex-col" aria-label={t("shell.busy.whatWouldStop")}>
                {shown.map((item) => (
                    <RunningRow key={item.blockId} item={item} />
                ))}
            </ul>
            {more > 0 ? <div className="text-muted">{t("shell.busy.andMore", { count: more })}</div> : null}
        </div>
    );
}

// Focus goes back where the close started (a terminal, a tab) when the dialog keeps everything.
export function useRestoreFocus() {
    const previous = useRef<HTMLElement>(null);
    useEffect(() => {
        previous.current = document.activeElement as HTMLElement;
        return () => {
            const el = previous.current;
            if (el?.isConnected) {
                el.focus();
            }
        };
    }, []);
}

function BusyCloseDialog({ request }: { request: BusyCloseRequest }) {
    const t = useT();
    const text = busyCloseText(request.action, request.tabName ?? workspaceShownName(request.name, t), request.quits);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const blockAtom = request.blockId
        ? getWaveObjectAtom<Block>(makeORef("block", request.blockId))
        : (NullAtom as Atom<Block>);
    const tabAtom = request.tabId ? getWaveObjectAtom<Tab>(makeORef("tab", request.tabId)) : (NullAtom as Atom<Tab>);
    const block = useAtomValue(blockAtom);
    const tab = useAtomValue(tabAtom);
    useRestoreFocus();
    useEffect(() => {
        cancelRef.current?.focus();
    }, []);
    // What it would close went meanwhile (another window closed it, its last shell exited): nothing left to ask.
    const gone = (request.blockId != null && block == null) || (request.tabId != null && tab == null);
    useEffect(() => {
        if (gone) {
            request.answer(false);
        }
    }, [gone]);
    useEscape(true, () => request.answer(false));
    return (
        <DialogFrame
            role="molten-busy-close"
            title={text.title}
            subtitle={text.subtitle}
            trapFocus
            buttons={
                <>
                    <button ref={cancelRef} type="button" className={PlainButton} onClick={() => request.answer(false)}>
                        {t("common.cancel")}
                    </button>
                    <button type="button" className={DangerButton} onClick={() => request.answer(true)}>
                        {text.confirm}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <RunningList items={request.running} />
            <RunningList items={request.kept} heading={keptHeading()} />
        </DialogFrame>
    );
}

export function BusyCloseHost() {
    const request = useAtomValue(BusyCloseRequestAtom);
    if (request == null) {
        return null;
    }
    return <BusyCloseDialog key={`${request.blockId ?? ""}:${request.tabId ?? ""}`} request={request} />;
}
