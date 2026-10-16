// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Review comments drafted and discussed in the developer's language (FR-REV-009): one card per comment, used in the
// file's comments strip and in the AI panel. A card shows the comment's kind (comment or change request), state and
// lines, its text, and the developer's actions: edit, stage or unstage, drop or restore, accept an agent's proposal,
// discuss it with the review session (the agent's replies and rewrites show under it), and its history. The texts
// are the developer's or the agent's: rendered as text, or as markdown for the agent's replies, never executed.

import { Markdown } from "@/app/element/markdown";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { getLocale, t, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { ReviewComment, ReviewCommentAction, ReviewCommentKind, ReviewCommentMessage } from "./review-client";
import {
    canDiscuss,
    canEdit,
    commentActions,
    CommentEventLabels,
    CommentKindLabels,
    CommentStateLabels,
    groupComments,
    linesLabel,
    pendingRewrite,
    sideLabel,
} from "./review-selection";
import type { ReviewTabModel } from "./review-tab-model";

import "./review.css";

const SmallButton =
    "flex h-6 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 text-11 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const TextArea =
    "w-full resize-y rounded-4 border border-border bg-background px-2 py-1 text-12 text-primary outline-none focus:border-accent/60";

// The developer's actions, by name (stage, drop...).
const ActionLabels: Record<ReviewCommentAction, string> = {
    get stage() {
        return t("review.cmt.action.stage");
    },
    get unstage() {
        return t("review.cmt.action.unstage");
    },
    get drop() {
        return t("review.cmt.action.drop");
    },
    get restore() {
        return t("review.cmt.action.restore");
    },
    get accept() {
        return t("review.cmt.action.accept");
    },
};

const ActionTitles: Record<ReviewCommentAction, string> = {
    get stage() {
        return t("review.cmt.actionTitle.stage");
    },
    get unstage() {
        return t("review.cmt.actionTitle.unstage");
    },
    get drop() {
        return t("review.cmt.actionTitle.drop");
    },
    get restore() {
        return t("review.cmt.actionTitle.restore");
    },
    get accept() {
        return t("review.cmt.actionTitle.accept");
    },
};

const KindTitles: Record<ReviewCommentKind, string> = {
    get comment() {
        return t("review.cmt.kindTitle.comment");
    },
    get change() {
        return t("review.cmt.kindTitle.change");
    },
};

// KindToggle chooses a comment's kind (AC1).
export function KindToggle({
    value,
    onChange,
    disabled,
}: {
    value: ReviewCommentKind;
    onChange: (kind: ReviewCommentKind) => void;
    disabled?: boolean;
}) {
    const t = useT();
    return (
        <div
            className="flex w-fit overflow-hidden rounded-6 border border-border"
            role="group"
            aria-label={t("review.cmt.kind")}
            data-testid="review-comment-kind"
        >
            {(["comment", "change"] as ReviewCommentKind[]).map((kind) => (
                <button
                    key={kind}
                    type="button"
                    disabled={disabled}
                    aria-pressed={value === kind}
                    title={KindTitles[kind]}
                    onClick={() => onChange(kind)}
                    data-kind={kind}
                    className={cn(
                        "h-6 cursor-pointer border-r border-border px-2 text-11 last:border-r-0 disabled:cursor-default",
                        value === kind ? "bg-hover text-primary" : "text-secondary hover:text-primary"
                    )}
                >
                    {CommentKindLabels[kind]}
                </button>
            ))}
        </div>
    );
}

function formatTime(at: number): string {
    if (!at) {
        return "";
    }
    return new Date(at).toLocaleString(getLocale(), { dateStyle: "short", timeStyle: "short" });
}

// CommentCard is one comment with its actions. showFile: the card names its file (the AI panel lists all of them).
export function CommentCard({
    model,
    comment,
    showFile,
}: {
    model: ReviewTabModel;
    comment: ReviewComment;
    showFile?: boolean;
}) {
    const t = useT();
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(comment.original.text);
    const [kind, setKind] = useState<ReviewCommentKind>(comment.kind);
    const [discussing, setDiscussing] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const editable = canEdit(comment);
    const lines = `${sideLabel(comment.anchor.side)} · ${linesLabel(comment.anchor)}`;
    const where = showFile ? `${comment.anchor.path} · ${lines}` : lines;
    const run = (work: () => Promise<string>) => {
        setBusy(true);
        fireAndForget(async () => {
            const err = await work();
            setError(err);
            setBusy(false);
        });
    };
    const startEdit = () => {
        setText(comment.original.text);
        setKind(comment.kind);
        setEditing(true);
    };
    const save = () => {
        run(async () => {
            const err = await model.updateComment(comment, text, kind);
            if (err == null) {
                setEditing(false);
            }
            return err;
        });
    };
    const actions = commentActions(comment);
    return (
        <li
            className="flex flex-col gap-1 border-t border-border/50 px-3 py-1.5"
            data-testid="review-comment-row"
            data-commentid={comment.id}
            data-state={comment.state}
            data-kind={comment.kind}
            data-outdated={comment.outdated ? "true" : undefined}
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <span
                    className={cn(
                        "shrink-0 rounded-4 px-1 text-10 font-medium",
                        `molten-review-badge-${comment.state}`
                    )}
                >
                    {CommentStateLabels[comment.state] ?? comment.state}
                </span>
                {comment.kind === "change" ? (
                    <span
                        className="shrink-0 rounded-4 border border-accent/50 px-1 text-10 text-accent"
                        title={KindTitles.change}
                    >
                        {CommentKindLabels.change}
                    </span>
                ) : null}
                {comment.outdated ? (
                    <span className="shrink-0 rounded-4 border border-warning/50 px-1 text-10 text-warning">
                        {t("review.comment.outdated")}
                    </span>
                ) : null}
                <button
                    type="button"
                    className="min-w-0 cursor-pointer truncate text-left text-muted hover:text-primary disabled:cursor-default disabled:hover:text-muted"
                    onClick={() => model.revealComment(comment)}
                    disabled={comment.outdated}
                    title={comment.outdated ? t("review.comment.outdatedTitle") : t("review.comment.showLines")}
                >
                    {comment.subject === "file" ? t("review.comment.fileLevelQuoting", { lines: where }) : where}
                </button>
            </div>
            {comment.state === "proposed" ? (
                <div className="text-11 text-muted">{t("review.cmt.proposedNote")}</div>
            ) : null}
            {comment.outdated || comment.subject === "file" ? (
                <pre className="max-h-24 overflow-auto rounded-4 bg-panel px-2 py-1 font-mono text-11 whitespace-pre-wrap text-muted">
                    {comment.anchor.excerpt}
                </pre>
            ) : null}
            {editing ? (
                <div className="flex flex-col gap-1">
                    <KindToggle value={kind} onChange={setKind} />
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={3}
                        className={TextArea}
                        data-testid="review-comment-edit-text"
                    />
                    <div className="flex justify-end gap-1.5">
                        <button type="button" className={SmallButton} onClick={() => setEditing(false)}>
                            {t("common.cancel")}
                        </button>
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-6 px-2.5 py-1 text-12"
                            disabled={text.trim() === "" || busy}
                            onClick={save}
                            data-testid="review-comment-edit-save"
                        >
                            {t("common.save")}
                            <MoltenWave />
                        </button>
                    </div>
                </div>
            ) : (
                <div
                    className={cn(
                        "whitespace-pre-wrap",
                        comment.state === "dropped" ? "text-muted line-through" : "text-primary"
                    )}
                    data-testid="review-comment-text-shown"
                >
                    {comment.original.text}
                </div>
            )}
            {!editing ? (
                <div className="flex flex-wrap items-center gap-1">
                    {actions.map((action) => (
                        <button
                            key={action}
                            type="button"
                            className={
                                action === "accept" || action === "stage"
                                    ? "molten-btn flex h-6 cursor-pointer items-center rounded-6 px-2 text-11"
                                    : cn(SmallButton, action === "drop" && "hover:text-danger")
                            }
                            disabled={busy}
                            title={ActionTitles[action]}
                            onClick={() => run(() => model.commentAction(comment, action))}
                            data-testid={`review-comment-${action}`}
                        >
                            {ActionLabels[action]}
                            {action === "accept" || action === "stage" ? <MoltenWave /> : null}
                        </button>
                    ))}
                    {editable ? (
                        <button
                            type="button"
                            className={SmallButton}
                            onClick={startEdit}
                            title={t("review.cmt.editTitle")}
                            data-testid="review-comment-edit"
                        >
                            <i className="fa fa-solid fa-pen text-10" />
                            {t("review.cmt.edit")}
                        </button>
                    ) : null}
                    {canDiscuss(comment) ? (
                        <button
                            type="button"
                            className={cn(SmallButton, discussing && "border-accent/60 text-primary")}
                            onClick={() => setDiscussing(!discussing)}
                            aria-expanded={discussing}
                            title={t("review.cmt.discussTitle")}
                            data-testid="review-comment-discuss"
                        >
                            <i className="fa fa-solid fa-sparkles text-10 text-accent" />
                            {t("review.cmt.discuss")}
                        </button>
                    ) : null}
                    {(comment.history?.length ?? 0) > 0 ? (
                        <button
                            type="button"
                            className="ml-auto cursor-pointer px-1 text-11 text-muted hover:text-primary"
                            onClick={() => setShowHistory(!showHistory)}
                            aria-expanded={showHistory}
                            data-testid="review-comment-history-toggle"
                        >
                            {t("review.cmt.history", { count: comment.history.length })}
                        </button>
                    ) : null}
                </div>
            ) : null}
            {error ? <div className="text-11 text-danger">{error}</div> : null}
            {discussing ? <DiscussBox model={model} comment={comment} /> : null}
            <Discussion model={model} comment={comment} />
            {showHistory ? <History comment={comment} /> : null}
        </li>
    );
}

// DiscussBox sends the comment to the review session with the developer's optional message (AC2).
function DiscussBox({ model, comment }: { model: ReviewTabModel; comment: ReviewComment }) {
    const t = useT();
    const [message, setMessage] = useState("");
    const [sending, setSending] = useState(false);
    const [outcome, setOutcome] = useState<{ text: string; tone: "ok" | "warn" | "error" }>(null);
    const send = () => {
        if (sending) {
            return;
        }
        setSending(true);
        fireAndForget(async () => {
            const { result, error } = await model.discussComment(comment, message);
            setSending(false);
            if (error) {
                setOutcome({ text: error, tone: "error" });
                return;
            }
            if (result.sent) {
                setMessage("");
                setOutcome({
                    text: result.submitted ? t("review.cmt.discussSent") : t("review.ask.typed"),
                    tone: "ok",
                });
                return;
            }
            setOutcome({
                text: `${result.message || t("review.cmt.notSent")}${result.busy ? " " + t("review.cmt.kept") : ""}`,
                tone: result.busy ? "warn" : "error",
            });
        });
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };
    return (
        <div className="flex flex-col gap-1 rounded-4 border border-border p-1.5" data-testid="review-discuss-box">
            <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                placeholder={t("review.cmt.messagePlaceholder")}
                className={TextArea}
                data-testid="review-discuss-message"
            />
            <div className="flex items-center gap-1.5">
                <span className="mr-auto text-11 text-muted">{t("review.ask.keys")}</span>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-6 px-2.5 py-1 text-12"
                    disabled={sending}
                    onClick={send}
                    data-testid="review-discuss-send"
                >
                    {sending ? t("review.ask.sending") : t("review.ask.send")}
                    <MoltenWave />
                </button>
            </div>
            {outcome ? (
                <p
                    className={cn(
                        "text-11",
                        outcome.tone === "ok" ? "text-success" : outcome.tone === "warn" ? "text-warning" : "text-danger"
                    )}
                    data-testid="review-discuss-outcome"
                >
                    {outcome.text}
                </p>
            ) : null}
        </div>
    );
}

// Discussion is the comment's exchange with the review session; a rewrite the agent proposed is used or ignored.
function Discussion({ model, comment }: { model: ReviewTabModel; comment: ReviewComment }) {
    const [error, setError] = useState<string>(null);
    const t = useT();
    const messages = comment.discussion ?? [];
    if (messages.length === 0) {
        return null;
    }
    const pending = pendingRewrite(comment);
    const use = (msg: ReviewCommentMessage, accept: boolean) => {
        fireAndForget(async () => setError(await model.useRewrite(comment, msg.id, accept)));
    };
    return (
        <ul className="flex flex-col gap-1 border-l-2 border-border pl-2" data-testid="review-discussion">
            {messages.map((msg) => (
                <li
                    key={msg.id}
                    className="flex flex-col gap-0.5"
                    data-by={msg.by}
                    data-testid="review-discussion-message"
                >
                    <div className="text-10 text-muted">
                        {msg.by === "agent" ? t("review.cmt.byAgent") : t("review.cmt.byYou")} · {formatTime(msg.at)}
                    </div>
                    {msg.by === "agent" ? (
                        <div className="min-w-0 text-12">
                            <Markdown
                                text={msg.text}
                                scrollable={false}
                                fontSizeOverride={12}
                                fixedFontSizeOverride={11}
                            />
                        </div>
                    ) : (
                        <div className="text-12 whitespace-pre-wrap text-secondary">
                            {msg.text || t("review.cmt.askedOpinion")}
                        </div>
                    )}
                    {msg.rewrite ? (
                        <div
                            className="flex flex-col gap-1 rounded-4 border border-border bg-panel px-2 py-1"
                            data-testid="review-rewrite"
                            data-rewritestate={msg.rewritestate}
                        >
                            <div className="text-10 text-muted">{t("review.cmt.rewriteProposed")}</div>
                            <div className="text-12 whitespace-pre-wrap">{msg.rewrite}</div>
                            {msg === pending && canEdit(comment) ? (
                                <div className="flex gap-1">
                                    <button
                                        type="button"
                                        className="molten-btn flex h-6 cursor-pointer items-center rounded-6 px-2 text-11"
                                        onClick={() => use(msg, true)}
                                        data-testid="review-rewrite-use"
                                    >
                                        {t("review.cmt.useRewrite")}
                                        <MoltenWave />
                                    </button>
                                    <button
                                        type="button"
                                        className={SmallButton}
                                        onClick={() => use(msg, false)}
                                        data-testid="review-rewrite-ignore"
                                    >
                                        {t("review.cmt.ignore")}
                                    </button>
                                </div>
                            ) : msg.rewritestate === "accepted" ? (
                                <div className="text-10 text-success">{t("review.cmt.used")}</div>
                            ) : msg.rewritestate === "ignored" ? (
                                <div className="text-10 text-muted">{t("review.cmt.ignored")}</div>
                            ) : null}
                        </div>
                    ) : null}
                </li>
            ))}
            {error ? <li className="text-11 text-danger">{error}</li> : null}
        </ul>
    );
}

// History lists the comment's original text and every later state (AC5).
function History({ comment }: { comment: ReviewComment }) {
    const t = useT();
    return (
        <ol className="flex flex-col gap-0.5 rounded-4 bg-panel px-2 py-1 text-11" data-testid="review-comment-history">
            {(comment.history ?? []).map((e, i) => (
                <li key={i} className="flex flex-col">
                    <span className="text-muted">
                        {formatTime(e.at)} · {CommentEventLabels[e.event] ?? e.event}
                        {e.by === "agent" ? " " + t("review.cmt.agentSuffix") : ""}
                        {e.kind === "change" && (e.event === "kind" || i === 0) ? ` · ${CommentKindLabels.change}` : ""}
                    </span>
                    {e.text ? <span className="whitespace-pre-wrap text-secondary">{e.text}</span> : null}
                </li>
            ))}
        </ol>
    );
}

// CommentsPanel is the AI panel's list of the PR's comments (AC3, AC4): the agent's proposals, the staged comments
// the next publication takes, the drafts, and the dropped ones.
export function CommentsPanel({ model }: { model: ReviewTabModel }) {
    const state = useAtomValue(model.stateAtom);
    const t = useT();
    const [showDropped, setShowDropped] = useState(false);
    const groups = groupComments(state);
    const total = groups.proposals.length + groups.staged.length + groups.drafts.length;
    return (
        <section
            className="flex flex-col gap-1.5"
            aria-label={t("review.cmt.panelAria")}
            data-testid="review-comments-panel"
        >
            <div className="flex items-center gap-1.5 font-medium">
                <i className="fa fa-solid fa-comment text-11" />
                {t("review.cmt.panelTitle")}
                <span className="text-11 font-normal text-muted" data-testid="review-comments-staged-count">
                    {t("review.cmt.stagedCount", { count: groups.staged.length })}
                </span>
            </div>
            {total === 0 && groups.dropped.length === 0 ? (
                <p className="text-11 text-muted">{t("review.cmt.empty")}</p>
            ) : null}
            <CommentGroup
                model={model}
                title={t("review.cmt.group.proposals")}
                comments={groups.proposals}
                testId="proposals"
            />
            <CommentGroup model={model} title={t("review.cmt.group.staged")} comments={groups.staged} testId="staged" />
            <CommentGroup model={model} title={t("review.cmt.group.drafts")} comments={groups.drafts} testId="drafts" />
            {groups.dropped.length > 0 ? (
                <button
                    type="button"
                    className="w-fit cursor-pointer text-11 text-muted hover:text-primary"
                    onClick={() => setShowDropped(!showDropped)}
                    aria-expanded={showDropped}
                    data-testid="review-comments-dropped-toggle"
                >
                    {showDropped
                        ? t("review.cmt.hideDropped", { count: groups.dropped.length })
                        : t("review.cmt.showDropped", { count: groups.dropped.length })}
                </button>
            ) : null}
            {showDropped ? (
                <CommentGroup
                    model={model}
                    title={t("review.cmt.group.dropped")}
                    comments={groups.dropped}
                    testId="dropped"
                />
            ) : null}
        </section>
    );
}

function CommentGroup({
    model,
    title,
    comments,
    testId,
}: {
    model: ReviewTabModel;
    title: string;
    comments: ReviewComment[];
    testId: string;
}) {
    if (comments.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-col rounded-6 border border-border" data-testid={`review-comments-${testId}`}>
            <div className="px-3 py-1 text-11 font-medium text-secondary">
                {title} ({comments.length})
            </div>
            <ul className="flex flex-col">
                {comments.map((c) => (
                    <CommentCard key={c.id} model={model} comment={c} showFile />
                ))}
            </ul>
        </div>
    );
}
