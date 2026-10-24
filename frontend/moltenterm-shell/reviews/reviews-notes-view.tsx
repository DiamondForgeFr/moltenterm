// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's Notes (FR-REV-008, DS-REV-012): the explanations the developer kept in this project, newest first,
// with a text filter. A note opens in place with its principles, text, other uses and sources; its path:line links open
// the file read from the project's git at the PR's merged commit, its head or the base branch, so they keep working
// after the merge. A note is renamed or deleted here, and nothing else removes one.

import { Markdown } from "@/app/element/markdown";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { errorPhrase, Phrase, useWordPhrase } from "../i18n/phrase";
import { timeAgo } from "../mission/time-format";
import { citedLine } from "../review/review-answers";
import { FileLink, parseFileLink } from "../review/review-model";
import {
    deleteReviewNote,
    filterNotes,
    newestFirst,
    renameReviewNote,
    ReviewNote,
    reviewNoteFile,
    ReviewNotes,
    useReviewNotes,
} from "../review/review-notes";
import { openFileInPreview } from "../term-copy/term-copy";

type NotesProps = { dir: string; repo: string; blockId: string };

// A filter another section asks for (Recently merged's notes chip, #843): at tells two asks of the same text apart.
export type NotesAsk = { filter: string; at: number };

export function NotesSection({ dir, repo, blockId, ask }: NotesProps & { ask?: NotesAsk }) {
    const t = useT();
    const { notes, error, set } = useReviewNotes(repo);
    const [filter, setFilter] = useState("");
    const [open, setOpen] = useState<string>(null);
    const sectionRef = useRef<HTMLElement>(null);
    const all = notes?.notes ?? [];
    const shown = useMemo(() => newestFirst(filterNotes(notes?.notes, filter)), [notes, filter]);
    useEffect(() => {
        if (ask == null) {
            return;
        }
        setFilter(ask.filter);
        sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }, [ask]);
    return (
        <section
            ref={sectionRef}
            className="flex flex-col gap-2"
            aria-label={t("review.notes.title")}
            data-testid="reviews-notes"
        >
            <div className="flex items-center gap-2">
                <h2 className="text-13 leading-5 font-semibold">
                    {t("review.notes.title")}
                    <span className="ml-2 text-12 font-normal text-muted">{all.length}</span>
                </h2>
                {all.length > 0 ? (
                    <input
                        type="search"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder={t("review.notes.filter")}
                        aria-label={t("review.notes.filter")}
                        className="ml-auto h-6 w-56 min-w-0 rounded-4 border border-border bg-transparent px-2 text-12 outline-none focus:border-accent/60"
                        data-testid="reviews-notes-filter"
                    />
                ) : null}
            </div>
            {error ? <p className="text-12 text-danger">{t("review.notes.readFailed", { error })}</p> : null}
            {notes != null && all.length === 0 ? (
                <p className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted">
                    {t("review.notes.empty")}
                </p>
            ) : null}
            {all.length > 0 && shown.length === 0 ? (
                <p className="text-12 text-muted">{t("review.notes.noMatch")}</p>
            ) : null}
            {shown.length > 0 ? (
                <div className="overflow-hidden rounded-4 border border-border" role="list">
                    {shown.map((n) => (
                        <NoteRow
                            key={n.id}
                            note={n}
                            open={open === n.id}
                            onToggle={() => setOpen(open === n.id ? null : n.id)}
                            dir={dir}
                            repo={repo}
                            blockId={blockId}
                            onNotes={set}
                        />
                    ))}
                </div>
            ) : null}
        </section>
    );
}

function NoteRow({
    note,
    open,
    onToggle,
    dir,
    repo,
    blockId,
    onNotes,
}: {
    note: ReviewNote;
    open: boolean;
    onToggle: () => void;
    onNotes: (notes: ReviewNotes) => void;
} & NotesProps) {
    const t = useT();
    const principles = (note.principles ?? []).filter((p) => p.trim() !== "");
    return (
        <div
            role="listitem"
            className="flex flex-col border-b border-border last:border-b-0"
            data-testid="reviews-note"
            data-id={note.id}
        >
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="flex cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-hover"
                data-testid="reviews-note-toggle"
            >
                <i
                    className={cn(
                        "fa fa-solid fa-chevron-right mt-1 w-2.5 text-10 text-muted transition-transform duration-120 ease-mt",
                        open && "rotate-90"
                    )}
                    aria-hidden
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-13 leading-5 font-medium" data-testid="reviews-note-title">
                        {note.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-11 text-muted">
                        <span>
                            PR #{note.pr?.number}
                            {note.pr?.title ? ` · ${note.pr.title}` : ""} ·{" "}
                            {t("review.notes.keptWhen", { when: timeAgo(new Date(note.keptat).toISOString()) })}
                        </span>
                        {principles.map((p) => (
                            <span key={p} className="rounded-4 bg-accent/10 px-1 text-10 text-accent">
                                {p}
                            </span>
                        ))}
                    </span>
                </div>
            </button>
            {open ? <NoteBody note={note} dir={dir} repo={repo} blockId={blockId} onNotes={onNotes} /> : null}
        </div>
    );
}

function NoteBody({
    note,
    dir,
    repo,
    blockId,
    onNotes,
}: {
    note: ReviewNote;
    onNotes: (notes: ReviewNotes) => void;
} & NotesProps) {
    const t = useT();
    const word = useWordPhrase();
    const [error, setError] = useState<Phrase>(null);
    const [renaming, setRenaming] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const related = (note.related ?? []).filter((r) => r.trim() !== "");
    const sources = (note.sources ?? []).filter((s) => s.trim() !== "");
    const openLink = (link: FileLink) =>
        fireAndForget(async () => {
            setError(null);
            try {
                const res = await reviewNoteFile(repo, note.id, dir, link.path);
                await openFileInPreview({ path: res.file, line: link.line, conn: "" }, blockId);
            } catch (e) {
                setError(errorPhrase(e));
            }
        });
    const run = (action: () => Promise<ReviewNotes>) =>
        fireAndForget(async () => {
            setError(null);
            try {
                onNotes(await action());
            } catch (e) {
                setError(errorPhrase(e));
            }
        });
    const onClickCapture = (e: React.MouseEvent) => {
        const link = parseFileLink((e.target as HTMLElement).closest?.("a")?.getAttribute("href"));
        if (link == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        openLink(link);
    };
    const anchor = note.anchor;
    return (
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3 pl-8 text-12" data-testid="reviews-note-body">
            {renaming ? (
                <RenameForm
                    title={note.title}
                    onCancel={() => setRenaming(false)}
                    onSave={(title) => {
                        setRenaming(false);
                        run(() => renameReviewNote(repo, note.id, title));
                    }}
                />
            ) : null}
            {note.technique && note.technique !== note.title ? (
                <div className="font-semibold text-primary">{note.technique}</div>
            ) : null}
            {anchor ? (
                anchor.side === "RIGHT" ? (
                    <CodeLink
                        text={`${anchor.path}:${anchor.startline ?? anchor.line}`}
                        onOpen={() => openLink({ path: anchor.path, line: anchor.startline ?? anchor.line })}
                    />
                ) : (
                    <span className="font-mono text-11 text-muted">
                        {anchor.path}:{anchor.startline ?? anchor.line}
                    </span>
                )
            ) : null}
            {note.question ? (
                <div className="flex flex-col gap-0.5">
                    <span className="text-10 font-medium text-muted uppercase">{t("review.answers.youAsked")}</span>
                    <span className="whitespace-pre-wrap text-secondary">{note.question}</span>
                </div>
            ) : null}
            <div
                className="min-w-0 [&_.heading]:!mt-3 [&_.heading]:!border-b-0 [&_.heading]:!pt-0 [&_.heading]:!pb-0 [&_.heading]:!text-13 [&_.heading]:!font-semibold"
                onClickCapture={onClickCapture}
                data-testid="reviews-note-text"
            >
                <Markdown text={note.markdown} scrollable={false} fontSizeOverride={12} fixedFontSizeOverride={11} />
            </div>
            {related.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-11 text-muted">
                    <span>{t("review.answers.related")}</span>
                    {related.map((r) => (
                        <NoteRef key={r} text={r} onOpen={openLink} />
                    ))}
                </div>
            ) : null}
            {sources.length > 0 ? (
                <div className="flex flex-col gap-0.5 text-11 text-muted">
                    <span className="text-10 font-medium uppercase">{t("review.answers.sourcesTitle")}</span>
                    <ul className="flex list-disc flex-col gap-0.5 pl-4">
                        {sources.map((s) => (
                            <li key={s}>
                                <NoteRef text={s} onOpen={openLink} />
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {error != null ? (
                <p className="text-11 text-danger" data-testid="reviews-note-error">
                    {word(error)}
                </p>
            ) : null}
            <div className="flex items-center gap-1.5 text-11">
                {!renaming ? (
                    <button
                        type="button"
                        className="cursor-pointer rounded-4 border border-border px-1.5 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                        onClick={() => setRenaming(true)}
                        data-testid="reviews-note-rename"
                    >
                        {t("review.notes.rename")}
                    </button>
                ) : null}
                {confirmDelete ? (
                    <>
                        <span className="text-muted">{t("review.notes.deleteConfirm")}</span>
                        <button
                            type="button"
                            className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-1.5 py-0.5 text-11"
                            onClick={() => run(() => deleteReviewNote(repo, note.id))}
                            data-testid="reviews-note-delete-confirm"
                        >
                            {t("review.notes.delete")}
                        </button>
                        <button
                            type="button"
                            className="cursor-pointer px-1.5 py-0.5 text-secondary hover:text-primary"
                            onClick={() => setConfirmDelete(false)}
                        >
                            {t("review.notes.cancel")}
                        </button>
                    </>
                ) : (
                    <button
                        type="button"
                        className="cursor-pointer rounded-4 border border-border px-1.5 py-0.5 text-secondary hover:border-error/50 hover:text-danger"
                        onClick={() => setConfirmDelete(true)}
                        data-testid="reviews-note-delete"
                    >
                        {t("review.notes.delete")}
                    </button>
                )}
                {note.agent ? (
                    <span className="ml-auto truncate text-muted">
                        {t("review.notes.byAgent", { agent: note.agent })}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

function RenameForm({
    title,
    onSave,
    onCancel,
}: {
    title: string;
    onSave: (title: string) => void;
    onCancel: () => void;
}) {
    const t = useT();
    const [value, setValue] = useState(title);
    const save = () => {
        if (value.trim() === "") {
            return;
        }
        onSave(value);
    };
    return (
        <div className="flex items-center gap-1.5">
            <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        save();
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        onCancel();
                    }
                }}
                aria-label={t("review.notes.titleLabel")}
                maxLength={200}
                className="h-6 min-w-0 flex-1 rounded-4 border border-border bg-transparent px-2 text-12 outline-none focus:border-accent/60"
                data-testid="reviews-note-title-input"
            />
            <button
                type="button"
                className="molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                onClick={save}
                disabled={value.trim() === ""}
                data-testid="reviews-note-title-save"
            >
                {t("review.notes.save")}
            </button>
            <button
                type="button"
                className="cursor-pointer px-1.5 py-0.5 text-11 text-secondary hover:text-primary"
                onClick={onCancel}
            >
                {t("review.notes.cancel")}
            </button>
        </div>
    );
}

function NoteRef({ text, onOpen }: { text: string; onOpen: (link: FileLink) => void }) {
    const link = citedLine(text);
    if (link == null) {
        return <span className="break-words">{text}</span>;
    }
    return <CodeLink text={text} onOpen={() => onOpen(link)} />;
}

function CodeLink({ text, onOpen }: { text: string; onOpen: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            className="w-fit cursor-pointer text-left font-mono text-11 break-all text-secondary hover:text-primary hover:underline"
            onClick={onOpen}
            title={t("review.notes.openLine")}
            data-testid="reviews-note-coderef"
        >
            {text}
        </button>
    );
}
