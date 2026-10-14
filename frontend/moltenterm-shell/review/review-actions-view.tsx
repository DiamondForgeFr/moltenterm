// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line selection's views (FR-REV-003): the actions next to the selected lines, the inline comment box, the file's
// comments under its header (line, file-level and outdated ones, with their state, review-comments-view.tsx), and Ask
// the AI's box in the AI panel. Every text shown here is the developer's or the diff's, rendered as text.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { MoltenWave } from "../molten-button";
import { ReviewCommentKind } from "./review-client";
import { CommentCard, KindToggle } from "./review-comments-view";
import { anchorLabel, commentsOfFile, linesLabel, sideLabel } from "./review-selection";
import type { ReviewComposer, ReviewTabModel } from "./review-tab-model";

import "./review.css";

const SmallButton =
    "flex h-6 cursor-pointer items-center gap-1.5 rounded-6 border border-border bg-modalbg px-2 text-12 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

const IsMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "");
const AltKey = IsMac ? "⌥" : "Alt+";
// After the session's terminal was inserted and focused.
const FocusBackMs = 400;

// SelectionOverlay floats over the diff: the selection's actions, or the comment box.
export function SelectionOverlay({ model }: { model: ReviewTabModel }) {
    const selection = useAtomValue(model.selectionAtom);
    const composer = useAtomValue(model.composerAtom);
    const pos = useAtomValue(model.overlayAtom);
    if (pos == null || !pos.visible) {
        return null;
    }
    if (composer != null) {
        return (
            <CommentBox key={composer.id ?? "new"} model={model} composer={composer} top={pos.top} left={pos.left} />
        );
    }
    if (selection == null) {
        return null;
    }
    return (
        <div
            className="absolute z-10 flex items-center gap-1 rounded-6 border border-border bg-modalbg p-1 shadow-lg"
            style={{ top: pos.top + 2, left: pos.left }}
            role="toolbar"
            aria-label={`Selected: ${anchorLabel(selection.anchor)}`}
            data-testid="review-selection-actions"
        >
            <button
                type="button"
                className={SmallButton}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => model.askSelection()}
                title={`Ask the AI about ${linesLabel(selection.anchor)} (${AltKey}A)`}
                data-testid="review-ask"
            >
                <i className="fa fa-solid fa-sparkles text-11 text-accent" />
                Ask the AI
                <kbd className="text-10 text-muted">{AltKey}A</kbd>
            </button>
            <button
                type="button"
                className={SmallButton}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => model.openComposer()}
                title={
                    selection.linecomment
                        ? `Comment ${linesLabel(selection.anchor)} (${AltKey}C)`
                        : `${selection.filereason} (${AltKey}C)`
                }
                data-testid="review-comment"
            >
                <i className="fa fa-solid fa-comment text-11" />
                {selection.linecomment ? "Comment" : "Comment (file)"}
                <kbd className="text-10 text-muted">{AltKey}C</kbd>
            </button>
        </div>
    );
}

function CommentBox({
    model,
    composer,
    top,
    left,
}: {
    model: ReviewTabModel;
    composer: ReviewComposer;
    top: number;
    left: number;
}) {
    const [text, setText] = useState(composer.text);
    const [kind, setKind] = useState<ReviewCommentKind>(composer.kind ?? "comment");
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    const save = () => {
        if (text.trim() === "" || composer.saving) {
            return;
        }
        fireAndForget(() => model.saveComment(composer, text, kind));
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            model.closeComposer();
            return;
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
        }
    };
    const where =
        composer.subject === "file"
            ? `File-level comment quoting ${linesLabel(composer.anchor)} (${sideLabel(composer.anchor.side)})`
            : `Comment on ${linesLabel(composer.anchor)} (${sideLabel(composer.anchor.side)})`;
    return (
        <div
            className="absolute z-10 flex w-[380px] max-w-[calc(100%-24px)] flex-col gap-1.5 rounded-6 border border-border bg-modalbg p-2 text-12 shadow-lg"
            style={{ top: top + 2, left }}
            data-testid="review-comment-box"
        >
            <div className="flex items-center gap-1.5 text-secondary">
                <i className="fa fa-solid fa-comment text-11" />
                <span className="min-w-0 truncate">{composer.id ? `Edit: ${where}` : where}</span>
            </div>
            {composer.filereason && !composer.id ? (
                <div className="text-11 text-muted">{composer.filereason}</div>
            ) : null}
            <KindToggle value={kind} onChange={setKind} />
            <textarea
                ref={ref}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                rows={4}
                placeholder={
                    kind === "change"
                        ? "What should be reworked, in your language"
                        : "Your comment or question for the author, in your language"
                }
                className="w-full resize-y rounded-4 border border-border bg-background px-2 py-1.5 text-12 text-primary outline-none focus:border-accent/60"
                data-testid="review-comment-text"
            />
            {composer.error ? <div className="text-11 text-error">{composer.error}</div> : null}
            <div className="flex items-center justify-end gap-1.5">
                <span className="mr-auto text-11 text-muted">{IsMac ? "⌘" : "Ctrl+"}Enter to save, Esc to cancel</span>
                <button type="button" className={SmallButton} onClick={() => model.closeComposer()}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-6 px-2.5 py-1 text-12"
                    disabled={text.trim() === "" || composer.saving}
                    onClick={save}
                    data-testid="review-comment-save"
                >
                    {composer.id ? "Save" : "Save draft"}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}

// CommentsStrip lists the file's comments under its header: the ones in the gutter, the file-level ones and the
// outdated ones, which only show here with their excerpt.
export function CommentsStrip({ model, path }: { model: ReviewTabModel; path: string }) {
    const state = useAtomValue(model.stateAtom);
    const [open, setOpen] = useState(true);
    const comments = commentsOfFile(state, path);
    if (comments.length === 0) {
        return null;
    }
    return (
        <div
            className="max-h-[35%] shrink-0 overflow-auto border-b border-border text-12"
            data-testid="review-comments"
        >
            <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1 text-left text-secondary hover:bg-hover"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
            >
                <i
                    className={cn(
                        "fa fa-solid fa-chevron-right w-2.5 text-10 transition-transform duration-120 ease-mt",
                        open && "rotate-90"
                    )}
                />
                <i className="fa fa-solid fa-comment text-11" />
                {comments.length === 1 ? "1 comment" : `${comments.length} comments`}
            </button>
            {open ? (
                <ul className="flex flex-col">
                    {comments.map((c) => (
                        <CommentCard key={c.id} model={model} comment={c} />
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

// AskBox is Ask the AI's box in the AI panel (AC2): the selection named, the question, what sending did.
export function AskBox({ model }: { model: ReviewTabModel }) {
    const ask = useAtomValue(model.askAtom);
    const [question, setQuestion] = useState("");
    const ai = useAtomValue(model.aiAtom);
    const ref = useRef<HTMLTextAreaElement>(null);
    const sessionBlock = ai.session?.blockid;
    // The session's terminal takes the focus when it is inserted: the question box takes it back, or the question
    // would be typed straight into the agent.
    useEffect(() => {
        if (!ask?.seq) {
            return;
        }
        ref.current?.focus();
        const timer = setTimeout(() => ref.current?.focus(), FocusBackMs);
        return () => clearTimeout(timer);
    }, [ask?.seq, sessionBlock]);
    if (ask == null) {
        return null;
    }
    const send = () => {
        fireAndForget(async () => {
            if (await model.sendAsk(question)) {
                setQuestion("");
            }
        });
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };
    const excerpt = (ask.text ?? "").split("\n");
    return (
        <section className="flex flex-col gap-1.5" aria-label="Ask the AI" data-testid="review-ask-box">
            <div className="flex items-center gap-1.5 font-medium">
                <i className="fa fa-solid fa-sparkles text-11 text-accent" />
                Ask the AI
            </div>
            {ask.anchor ? (
                <div className="flex flex-col gap-1 rounded-4 border border-border px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                        <span
                            className="min-w-0 flex-1 truncate font-mono text-11"
                            title={anchorLabel(ask.anchor)}
                            data-testid="review-ask-anchor"
                        >
                            {anchorLabel(ask.anchor)}
                        </span>
                        <button
                            type="button"
                            className="cursor-pointer px-1 text-muted hover:text-primary"
                            onClick={() => model.clearAskSelection()}
                            title="Ask about the whole PR instead"
                            aria-label="Remove the selection"
                        >
                            <i className="fa fa-solid fa-xmark text-11" />
                        </button>
                    </div>
                    <pre className="max-h-20 overflow-hidden font-mono text-11 whitespace-pre-wrap text-muted">
                        {excerpt.slice(0, 4).join("\n")}
                        {excerpt.length > 4 ? "\n…" : ""}
                    </pre>
                </div>
            ) : (
                <div className="text-11 text-muted">About the whole PR.</div>
            )}
            <textarea
                ref={ref}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={onKeyDown}
                rows={3}
                placeholder="Your question, in your language"
                className="w-full resize-y rounded-4 border border-border bg-background px-2 py-1.5 text-12 text-primary outline-none focus:border-accent/60"
                data-testid="review-ask-question"
            />
            <div className="flex items-center gap-1.5">
                <span className="mr-auto text-11 text-muted">Enter to send, Shift+Enter for a new line</span>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-6 px-2.5 py-1 text-12"
                    disabled={question.trim() === "" || ask.sending}
                    onClick={send}
                    data-testid="review-ask-send"
                >
                    {ask.sending ? "Sending…" : "Send"}
                    <MoltenWave />
                </button>
            </div>
            <AskOutcome ask={ask} waiting={(ai.session?.questions ?? []).map((q) => q.id)} />
        </section>
    );
}

// What a queued question's outcome says (FR-REV-006 AC4); the queue itself is listed under the box.
const AskQueuedNext = "Queued: it is sent when your agent is idle, and its answer shows under this box.";
const AskQueuedBehindOne = "Queued behind 1 other question: each is sent when your agent is idle.";
const AskQueuedBehind = "Queued behind %d other questions: each is sent when your agent is idle.";
const AskQueuedSent = "Sent to the review session from the queue: its answer shows under this box.";

function queuedText(position: number): string {
    if (position <= 1) {
        return AskQueuedNext;
    }
    return position === 2 ? AskQueuedBehindOne : AskQueuedBehind.replace("%d", String(position - 1));
}

function AskOutcome({
    ask,
    waiting,
}: {
    ask: {
        result?: {
            sent: boolean;
            submitted?: boolean;
            busy?: boolean;
            queued?: boolean;
            questionid?: string;
            position?: number;
            message?: string;
        };
        error?: string;
    };
    // The ids of the questions still waiting in the session's queue.
    waiting: readonly string[];
}) {
    if (ask.error) {
        return (
            <p className="text-11 text-error" data-testid="review-ask-outcome">
                {ask.error}
            </p>
        );
    }
    const result = ask.result;
    if (result == null) {
        return null;
    }
    if (result.queued && !waiting.includes(result.questionid)) {
        return (
            <p className="text-11 text-success" data-testid="review-ask-outcome">
                {AskQueuedSent}
            </p>
        );
    }
    if (result.queued) {
        return (
            <p className="text-11 text-warning" data-testid="review-ask-outcome">
                {result.message ? `${result.message} ` : ""}
                {queuedText(result.position ?? 1)}
            </p>
        );
    }
    if (result.sent) {
        return (
            <p className="text-11 text-success" data-testid="review-ask-outcome">
                {result.submitted
                    ? "Sent to the review session: the answer comes in its terminal."
                    : "Typed in the agent's prompt after your draft there: press Enter in its terminal to send it."}
            </p>
        );
    }
    return (
        <p className={cn("text-11", result.busy ? "text-warning" : "text-error")} data-testid="review-ask-outcome">
            {result.message || "The question could not be typed."}
            {result.busy ? " Your question is kept: send it again when the agent is idle." : ""}
        </p>
    );
}
