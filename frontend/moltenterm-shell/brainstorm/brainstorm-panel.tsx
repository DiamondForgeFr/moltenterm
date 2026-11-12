// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The brainstorm panel (FR-BOSS-010 AC9, AC10, AC10c, AC11, AC23, AC25, DS-BOSS-013, #2285): in Brokk's group, in the
// rail's place beside his square, for the whole mode. It holds what the bottom-right Brainstorms widget held (#2248):
// the open brainstorm's title, where it is saved and when, its folder; the other brainstorms, the unfinished ones first
// and marked, with Resume, Rename, Show in folder and Delete, which asks first; New idea and Leave the brainstorm; his
// fork's question and the line about the last action. Each action is the developer's click. It loads with the
// brainstorm (brokk-group.tsx), whose group draws its frame at once.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { ReactNode, useEffect, useRef, useState } from "react";
import { BossBubbleModel } from "../boss/boss-store";
import { TFunction, useLocale, useT } from "../i18n/i18n";
import { lastChange, othersOf, stateOf, unfinished } from "./brainstorm-model";
import "./brainstorm-panel.css";
import { ForgetConfirm } from "./brainstorm-prompts";
import { BrainstormModel, BrainstormState, BrainstormSummary, FolderNotice } from "./brainstorm-store";

function savedTime(at: number, locale: string): string {
    try {
        return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
    } catch {
        return new Date(at).toLocaleTimeString();
    }
}

function revealFolder(dir: string): void {
    try {
        getApi().revealNativePath(dir);
    } catch (e) {
        console.log("brainstorm: the folder could not be shown", e);
    }
}

// The panel's Leave the brainstorm (AC2a, #2257, #2284): the one way out with the pointer, whatever Brokk is doing.
export function leaveBrainstorm(): void {
    void BrainstormModel.getInstance().end();
}

// Where the open brainstorm is saved, and when (AC9).
export function savedLine(
    state: BrainstormState,
    t: TFunction,
    locale: string
): { text: string; tone: "ok" | "waiting" | "failed" } {
    const savedAt = state?.savedat || state?.brainstorm?.updated || 0;
    if (state?.saveerror) {
        return { text: t("boss.brainstorm.saved.failed"), tone: "failed" };
    }
    if (state?.brainstorm == null || !savedAt) {
        return { text: t("boss.brainstorm.saved.nothing"), tone: "waiting" };
    }
    return { text: t("boss.brainstorm.saved.at", { time: savedTime(savedAt, locale) }), tone: "ok" };
}

function RenameField({ summary, onDone }: { summary: BrainstormSummary; onDone: () => void }) {
    const t = useT();
    const [value, setValue] = useState(summary.title);
    const [busy, setBusy] = useState(false);
    const save = async () => {
        if (busy) {
            return;
        }
        setBusy(true);
        const done = await BrainstormModel.getInstance().rename(summary.slug, value);
        setBusy(false);
        if (done) {
            onDone();
        }
    };
    return (
        <form
            className="mt-bsp-rename"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            <input
                autoFocus
                value={value}
                maxLength={160}
                disabled={busy}
                aria-label={t("boss.brainstorm.panel.renameLabel")}
                data-testid="brainstorm-rename-input"
                className="mt-bsp-rename-input"
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        onDone();
                    }
                }}
            />
            <button
                type="submit"
                disabled={busy || value.trim() === ""}
                className="mt-bsp-link cursor-pointer"
                data-testid="brainstorm-rename-save"
            >
                {t("boss.brainstorm.panel.renameSave")}
            </button>
        </form>
    );
}

function NoticeLine({ notice }: { notice: FolderNotice }) {
    const t = useT();
    if (notice == null) {
        return null;
    }
    const text =
        notice.kind === "forgot"
            ? t(notice.trashed ? "boss.brainstorm.panel.forgotTrash" : "boss.brainstorm.panel.forgotRemoved", {
                  title: notice.title,
              })
            : t(`boss.brainstorm.failed.${notice.failure}`);
    return (
        <div className="mt-bsp-notice" role="status" data-kind={notice.kind} data-testid="brainstorm-notice">
            {text}
        </div>
    );
}

function ForkQuestion() {
    const t = useT();
    const model = BrainstormModel.getInstance();
    const fork = useAtomValue(model.forkAtom, { store: globalStore });
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const [busy, setBusy] = useState(false);
    if (fork == null) {
        return null;
    }
    return (
        <div
            className="mt-bsp-fork"
            role="group"
            aria-label={t("boss.brainstorm.fork.label")}
            data-testid="brainstorm-fork"
        >
            <span>{t("boss.brainstorm.fork.ask", { name, title: fork.title })}</span>
            <span className="mt-bsp-links">
                <button
                    type="button"
                    disabled={busy}
                    className="mt-bsp-link cursor-pointer"
                    data-testid="brainstorm-fork-yes"
                    onClick={async () => {
                        setBusy(true);
                        try {
                            await model.forkYes();
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {t("boss.brainstorm.fork.yes")}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    className="mt-bsp-link cursor-pointer"
                    data-testid="brainstorm-fork-no"
                    onClick={() => model.forkNo()}
                >
                    {t("boss.brainstorm.fork.no")}
                </button>
            </span>
        </div>
    );
}

// The state a row says (AC25): in progress, with the ember of what is still warm, or finished.
function StateMark({ entry }: { entry: BrainstormSummary }) {
    const t = useT();
    const state = stateOf(entry);
    return (
        <span className="mt-bsp-mark" data-state={unfinished(entry) ? "open" : "done"} data-testid="brainstorm-mark">
            {t(`boss.brainstorm.state.${state}`)}
        </span>
    );
}

// Rename, Show in folder and Delete of a brainstorm; Delete asks first (AC10d).
function FolderLinks({
    entry,
    onRename,
    onDelete,
}: {
    entry: BrainstormSummary;
    onRename: () => void;
    onDelete: () => void;
}) {
    const t = useT();
    return (
        <>
            <button
                type="button"
                className="mt-bsp-link cursor-pointer"
                data-testid="brainstorm-row-rename"
                onClick={onRename}
            >
                {t("boss.brainstorm.panel.rename")}
            </button>
            <button
                type="button"
                className="mt-bsp-link cursor-pointer"
                data-testid="brainstorm-row-show"
                onClick={() => revealFolder(entry.dir)}
            >
                {t("boss.brainstorm.panel.show")}
            </button>
            <button
                type="button"
                className="mt-bsp-link mt-bsp-link-danger cursor-pointer"
                data-testid="brainstorm-row-delete"
                onClick={onDelete}
            >
                {t("boss.brainstorm.panel.delete")}
            </button>
        </>
    );
}

function useForget(entry: BrainstormSummary): {
    mode: "idle" | "rename" | "delete";
    setMode: (mode: "idle" | "rename" | "delete") => void;
    confirm: ReactNode;
} {
    const model = BrainstormModel.getInstance();
    const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
    const [busy, setBusy] = useState(false);
    const confirm =
        mode === "delete" && entry != null ? (
            <ForgetConfirm
                summary={entry}
                busy={busy}
                onConfirm={async () => {
                    setBusy(true);
                    try {
                        await model.forgetFolder(entry);
                    } finally {
                        setBusy(false);
                        setMode("idle");
                    }
                }}
                onCancel={() => setMode("idle")}
            />
        ) : null;
    return { mode, setMode, confirm };
}

function Row({ entry }: { entry: BrainstormSummary }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormModel.getInstance();
    const { mode, setMode, confirm } = useForget(entry);
    if (confirm != null) {
        return (
            <li className="mt-bsp-row" data-testid="brainstorm-row" data-slug={entry.slug}>
                {confirm}
            </li>
        );
    }
    return (
        <li className="mt-bsp-row" data-testid="brainstorm-row" data-slug={entry.slug}>
            <div className="mt-bsp-row-main">
                {mode === "rename" ? (
                    <RenameField summary={entry} onDone={() => setMode("idle")} />
                ) : (
                    <span className="mt-bsp-row-title" title={entry.title}>
                        {entry.title}
                    </span>
                )}
                <span className="mt-bsp-row-meta">
                    <StateMark entry={entry} />
                    <span>{t("boss.brainstorm.lastChange", { when: lastChange(entry.updated, locale) })}</span>
                </span>
            </div>
            <div className="mt-bsp-row-acts">
                <button
                    type="button"
                    className="mt-bsp-resume cursor-pointer"
                    data-testid="brainstorm-row-load"
                    title={t("boss.brainstorm.panel.resumeOne", { title: entry.title })}
                    onClick={() => void model.load(entry.slug)}
                >
                    {t("boss.brainstorm.resumeAction")}
                </button>
                <button
                    type="button"
                    className="mt-bsp-more cursor-pointer"
                    aria-label={t("boss.brainstorm.panel.more", { title: entry.title })}
                    title={t("boss.brainstorm.panel.more", { title: entry.title })}
                    aria-haspopup="menu"
                    data-testid="brainstorm-row-more"
                    onClick={(e) =>
                        ContextMenuModel.getInstance().showContextMenu(
                            rowMenu(t, entry, {
                                onRename: () => setMode("rename"),
                                onDelete: () => setMode("delete"),
                            }),
                            e
                        )
                    }
                >
                    <i className={makeIconClass("ellipsis", false)} aria-hidden />
                </button>
            </div>
        </li>
    );
}

// The rest of a listed brainstorm's actions, in its ⋯ menu so that the row keeps the room for its title: Rename, Show
// in folder, and Delete, which asks first in the row (AC10, AC10d).
export function rowMenu(
    t: TFunction,
    entry: BrainstormSummary,
    on: { onRename: () => void; onDelete: () => void }
): ContextMenuItem[] {
    return [
        { label: t("boss.brainstorm.panel.rename"), click: on.onRename },
        { label: t("boss.brainstorm.panel.show"), click: () => revealFolder(entry.dir) },
        { type: "separator" },
        { label: t("boss.brainstorm.panel.delete"), click: on.onDelete },
    ];
}

// The open brainstorm: its title, where it is saved and when, its folder, and what the developer can do with it.
function Current({ state }: { state: BrainstormState }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormModel.getInstance();
    const brainstorm = state?.brainstorm;
    const { mode, setMode, confirm } = useForget(brainstorm);
    const saved = savedLine(state, t, locale);
    return (
        <div className="mt-bsp-head" data-testid="brainstorm-current">
            <div className="mt-bsp-eyebrow">
                <i className={makeIconClass("folder-open", false)} aria-hidden />
                <span className="mt-bsp-eyebrow-text">{t("boss.brainstorm.panel.eyebrow")}</span>
                <button
                    type="button"
                    className="mt-bsp-leave cursor-pointer"
                    data-testid="brainstorm-leave"
                    title={t("boss.brainstorm.leaveHint")}
                    onClick={leaveBrainstorm}
                >
                    <i className={makeIconClass("arrow-right-from-bracket", false)} aria-hidden />
                    {t("boss.brainstorm.leave")}
                </button>
            </div>
            {mode === "rename" && brainstorm != null ? (
                <RenameField summary={brainstorm} onDone={() => setMode("idle")} />
            ) : (
                <div className="mt-bsp-title" title={brainstorm?.title} data-testid="brainstorm-title">
                    {brainstorm?.title || t("boss.brainstorm.panel.untitled")}
                </div>
            )}
            <div className="mt-bsp-saved" data-tone={saved.tone} data-testid="brainstorm-saved-line">
                <span className="mt-bsp-saved-dot" aria-hidden />
                <span>{saved.text}</span>
                {brainstorm != null ? (
                    <span className="mt-bsp-folder" title={brainstorm.dir} data-testid="brainstorm-saved-folder">
                        {brainstorm.slug}/
                    </span>
                ) : null}
            </div>
            {confirm}
            <div className="mt-bsp-acts">
                <button
                    type="button"
                    className="mt-bsp-btn cursor-pointer"
                    data-testid="brainstorm-new"
                    onClick={() => void model.newIdea()}
                >
                    <i className={makeIconClass("plus", false)} aria-hidden />
                    {t("boss.brainstorm.newIdea")}
                </button>
                {brainstorm != null ? (
                    <span className="mt-bsp-links">
                        <FolderLinks
                            entry={brainstorm}
                            onRename={() => setMode("rename")}
                            onDelete={() => setMode("delete")}
                        />
                    </span>
                ) : null}
            </div>
        </div>
    );
}

export function BrainstormPanel() {
    const t = useT();
    const model = BrainstormModel.getInstance();
    const state = useAtomValue(model.stateAtom, { store: globalStore });
    const list = useAtomValue(model.listAtom, { store: globalStore });
    const notice = useAtomValue(model.noticeAtom, { store: globalStore });
    const asked = useAtomValue(model.listAskedAtom, { store: globalStore });
    const listRef = useRef<HTMLUListElement>(null);
    useEffect(() => {
        void model.refreshList();
    }, [model]);
    // All brainstorms… in the picker brings the list forward (AC10a): the first Resume takes the keyboard.
    const seenAsked = useRef(asked);
    useEffect(() => {
        if (asked === seenAsked.current) {
            return;
        }
        seenAsked.current = asked;
        const list = listRef.current;
        list?.scrollTo?.({ top: 0 });
        list?.querySelector<HTMLElement>("[data-testid='brainstorm-row-load']")?.focus({ preventScroll: true });
    }, [asked]);
    const others = othersOf(list, state?.brainstorm?.slug ?? "");
    return (
        <div className="mt-bsp" data-testid="brainstorm-panel">
            <Current state={state} />
            <ForkQuestion />
            <NoticeLine notice={notice} />
            <div className="mt-bsp-others">
                <span>{t("boss.brainstorm.panel.others")}</span>
                {others.length > 0 ? <span className="mt-bsp-count">{others.length}</span> : null}
            </div>
            <ul ref={listRef} className="mt-bsp-list" data-testid="brainstorm-list">
                {others.length === 0 ? (
                    <li className="mt-bsp-empty" data-testid="brainstorm-list-empty">
                        {t("boss.brainstorm.panel.none")}
                    </li>
                ) : null}
                {others.map((entry) => (
                    <Row key={entry.slug} entry={entry} />
                ))}
            </ul>
        </div>
    );
}
