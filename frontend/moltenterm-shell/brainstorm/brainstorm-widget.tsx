// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Brainstorms widget (FR-BOSS-010 AC9 to AC11, AC10c, DS-BOSS-010, #2248, the approved mockup): a brass-edged plate
// at the bottom right of the layer, in the free space and never over the graph. Folded, it says where the open
// brainstorm is saved and when, and names the other ideas; unfolded (All brainstorms…, or the header's switch), it lists
// every folder with its title, last change and state, and Load, Rename, Show in folder and Delete, which asks first.
// His fork's question waits in it: Open its own folder? Yes, or No, we stay here. Each action is the developer's click.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { BossBubbleModel } from "../boss/boss-store";
import { useLocale, useT } from "../i18n/i18n";
import { lastChange, othersOf } from "./brainstorm-model";
import { ForgetConfirm } from "./brainstorm-prompts";
import { BrainstormModel, BrainstormState, BrainstormSummary, FolderNotice } from "./brainstorm-store";

// The other ideas the folded widget names, as the mockup does.
const FoldedOthers = 2;

const KnownStates = ["open", "clear", "promoted"];

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
            className="mt-bs-rename"
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
                aria-label={t("boss.brainstorm.widget.renameLabel")}
                data-testid="brainstorm-rename-input"
                className="mt-bs-rename-input"
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
                className="mt-bs-link cursor-pointer"
                data-testid="brainstorm-rename-save"
            >
                {t("boss.brainstorm.widget.renameSave")}
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
            ? t(notice.trashed ? "boss.brainstorm.widget.forgotTrash" : "boss.brainstorm.widget.forgotRemoved", {
                  title: notice.title,
              })
            : t(`boss.brainstorm.failed.${notice.failure}`);
    return (
        <div className="mt-bs-notice" role="status" data-kind={notice.kind} data-testid="brainstorm-notice">
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
            className="mt-bs-fork"
            role="group"
            aria-label={t("boss.brainstorm.fork.label")}
            data-testid="brainstorm-fork"
        >
            <span>{t("boss.brainstorm.fork.ask", { name, title: fork.title })}</span>
            <span className="mt-bs-actions">
                <button
                    type="button"
                    disabled={busy}
                    className="mt-bs-link cursor-pointer"
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
                <span aria-hidden>·</span>
                <button
                    type="button"
                    disabled={busy}
                    className="mt-bs-link cursor-pointer"
                    data-testid="brainstorm-fork-no"
                    onClick={() => model.forkNo()}
                >
                    {t("boss.brainstorm.fork.no")}
                </button>
            </span>
        </div>
    );
}

function Row({ entry, current }: { entry: BrainstormSummary; current: boolean }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormModel.getInstance();
    const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
    const [busy, setBusy] = useState(false);
    const state = KnownStates.includes(entry.state) ? entry.state : "open";
    if (mode === "delete") {
        return (
            <li className="mt-bs-row" data-testid="brainstorm-row" data-slug={entry.slug}>
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
            </li>
        );
    }
    return (
        <li className={cn("mt-bs-row", current && "is-current")} data-testid="brainstorm-row" data-slug={entry.slug}>
            {mode === "rename" ? (
                <RenameField summary={entry} onDone={() => setMode("idle")} />
            ) : (
                <span className="mt-bs-row-title" title={entry.title}>
                    {entry.title}
                </span>
            )}
            <span className="mt-bs-row-meta">
                {t("boss.brainstorm.widget.meta", {
                    when: lastChange(entry.updated, locale),
                    state: t(`boss.brainstorm.state.${state}`),
                })}
            </span>
            <span className="mt-bs-actions">
                {current ? (
                    <span className="mt-bs-row-here">{t("boss.brainstorm.widget.here")}</span>
                ) : (
                    <button
                        type="button"
                        className="mt-bs-link cursor-pointer"
                        data-testid="brainstorm-row-load"
                        onClick={() => void model.load(entry.slug)}
                    >
                        {t("boss.brainstorm.widget.load")}
                    </button>
                )}
                <button
                    type="button"
                    className="mt-bs-link cursor-pointer"
                    data-testid="brainstorm-row-rename"
                    onClick={() => setMode("rename")}
                >
                    {t("boss.brainstorm.widget.rename")}
                </button>
                <button
                    type="button"
                    className="mt-bs-link cursor-pointer"
                    data-testid="brainstorm-row-show"
                    onClick={() => revealFolder(entry.dir)}
                >
                    {t("boss.brainstorm.widget.show")}
                </button>
                <button
                    type="button"
                    className="mt-bs-link mt-bs-link-danger cursor-pointer"
                    data-testid="brainstorm-row-delete"
                    onClick={() => setMode("delete")}
                >
                    {t("boss.brainstorm.widget.delete")}
                </button>
            </span>
        </li>
    );
}

export function BrainstormsWidget({ state }: { state: BrainstormState }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormModel.getInstance();
    const list = useAtomValue(model.listAtom, { store: globalStore });
    const unfolded = useAtomValue(model.widgetOpenAtom, { store: globalStore });
    const notice = useAtomValue(model.noticeAtom, { store: globalStore });
    useEffect(() => {
        void model.refreshList();
    }, [model]);
    const brainstorm = state.brainstorm;
    const others = othersOf(list, brainstorm?.slug ?? "");
    let line: string;
    let tone = "ok";
    // A brainstorm loaded was saved when it last changed.
    const savedAt = state.savedat || brainstorm?.updated || 0;
    if (state.saveerror) {
        line = t("boss.brainstorm.saved.failed");
        tone = "failed";
    } else if (brainstorm == null || !savedAt) {
        line = t("boss.brainstorm.saved.nothing");
        tone = "waiting";
    } else {
        line = t("boss.brainstorm.saved.at", { time: savedTime(savedAt, locale) });
    }
    const toggle = () => {
        const next = !unfolded;
        globalStore.set(model.widgetOpenAtom, next);
        if (next) {
            void model.refreshList();
        }
    };
    const rows: BrainstormSummary[] = brainstorm != null ? [brainstorm, ...others] : others;
    return (
        <div
            className={cn("mt-bs-saved", unfolded && "is-unfolded")}
            role="region"
            aria-label={t("boss.brainstorm.saved.title")}
            data-testid="brainstorm-saved"
            data-tone={tone}
        >
            <div className="mt-bs-saved-head">
                <i className={makeIconClass("folder-open", false)} aria-hidden />
                <span className="mt-bs-saved-name">{t("boss.brainstorm.saved.title")}</span>
                <button
                    type="button"
                    className="mt-bs-link cursor-pointer"
                    aria-expanded={unfolded}
                    data-testid="brainstorm-widget-toggle"
                    onClick={toggle}
                >
                    {unfolded
                        ? t("boss.brainstorm.widget.fold")
                        : t("boss.brainstorm.widget.all", { count: rows.length })}
                </button>
            </div>
            <div className="mt-bs-saved-line" data-testid="brainstorm-saved-line">
                {line}
            </div>
            {brainstorm != null ? (
                <div className="mt-bs-saved-folder" title={brainstorm.dir} data-testid="brainstorm-saved-folder">
                    {brainstorm.slug}/
                </div>
            ) : null}
            {unfolded ? (
                <ul className="mt-bs-list" data-testid="brainstorm-list">
                    {rows.length === 0 ? <li className="mt-bs-row-meta">{t("boss.brainstorm.widget.none")}</li> : null}
                    {rows.map((entry) => (
                        <Row key={entry.slug} entry={entry} current={entry.slug === brainstorm?.slug} />
                    ))}
                </ul>
            ) : (
                <div className="mt-bs-others" data-testid="brainstorm-others">
                    {others.length > 0 ? (
                        <>
                            <span>{t("boss.brainstorm.widget.others")}</span>
                            {others.slice(0, FoldedOthers).map((entry, i) => (
                                <span key={entry.slug}>
                                    {i > 0 ? <span aria-hidden> · </span> : " "}
                                    <button
                                        type="button"
                                        className="mt-bs-link cursor-pointer"
                                        data-testid="brainstorm-other"
                                        title={t("boss.brainstorm.widget.loadOne", { title: entry.title })}
                                        onClick={() => void model.load(entry.slug)}
                                    >
                                        {entry.slug}
                                    </button>
                                </span>
                            ))}
                            <span aria-hidden>. </span>
                        </>
                    ) : null}
                </div>
            )}
            <div className="mt-bs-actions">
                <button
                    type="button"
                    className="mt-bs-link cursor-pointer"
                    data-testid="brainstorm-new"
                    onClick={() => void model.newIdea()}
                >
                    {t("boss.brainstorm.newIdea")}
                </button>
                {brainstorm != null ? (
                    <>
                        <span aria-hidden>·</span>
                        <button
                            type="button"
                            className="mt-bs-link cursor-pointer"
                            data-testid="brainstorm-show"
                            onClick={() => revealFolder(brainstorm.dir)}
                        >
                            {t("boss.brainstorm.widget.show")}
                        </button>
                    </>
                ) : null}
            </div>
            <ForkQuestion />
            <NoticeLine notice={notice} />
            <div className="mt-bs-saved-hint">{t("boss.brainstorm.leaveHint")}</div>
        </div>
    );
}
