// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The field under Brokk's group and the conversation window it opens (FR-BOSS-009, AC15, AC17, AC22 to AC24, AC99 to
// AC104, #2003, #2028, #2032, #2033, #2382): the developer writes to him, and the message goes to his own terminal
// session through his one talk, the same in every page (brokk-session.ts). While the field has the focus, or text is
// left in it, the frame grows in place into a window shaped like today's chat composers: when nothing has been said it
// is only the composer, a compact rounded well with the field and one small row of controls under it, Send at its end
// (AC102, AC103); the field grows with the text up to six lines, then scrolls. Once something has been said, the
// exchange stacks above the composer (AC104): the developer's messages, his answers, the replies an answer offers as
// buttons (an authorisation asks once more), the request or the question his agent waits on, answered there (AC100,
// AC101), and the notes about a message his agent could not take, each with a way out. His terminal is a discreet link,
// only where something cannot be read in the window. He listens while the developer writes (onTyping). Folded, the
// field is one row as wide as the group, and what it says hangs under it, so the group's geometry never moves. While
// the window is open the panel beside the group gives way above it (onFocusChange, AC18, #2090). The way back to the
// brainstorm left is the resume card, folded and open (AC92, #2303).

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    BrainstormLastLeftAtom,
    BrainstormPromptAtom,
    BrainstormStateAtom,
    dismissLastBrainstorm,
    openBrainstorm,
    resumeLastBrainstorm,
} from "../brainstorm/brainstorm-boot";
import { ResumeCard } from "../brainstorm/brainstorm-resume-card";
import { useBrainstormAllowed } from "../build/use-feature-on";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { showPane } from "../sessions/pane-focus";
import { openSettingsSection } from "../settings/settings-open";
import { DominoLoader } from "../suite/suite";
import { BossBubbleModel } from "./boss-store";
import { ExchangeView } from "./brokk-exchange";
import { afterCancel, afterClick, afterConfirm, conversationOpen, InlineAction } from "./brokk-exchange-model";
import { BrokkSession } from "./brokk-session";
import {
    canSend,
    fieldAction,
    fieldAfterSend,
    fieldWithReturned,
    isQuestion,
    keepsText,
    MaxMessageLength,
    onItsWay,
    openQuestion,
    questionAnswers,
    QuestionPicks,
    sendsOnKey,
    showsCommandHint,
    talkFieldHeight,
    talkNoteKey,
    TalkState,
    talkTerminalAside,
    talkWaits,
    TalkWayOut,
    talkWayOut,
    talkWayOutKey,
} from "./brokk-talk-model";

// The questions about the brainstorms (#2248) load with the brainstorm, the first time one is asked.
const BrainstormPrompts = lazy(() =>
    import("../brainstorm/brainstorm-prompts").then((mod) => ({ default: mod.BrainstormPrompts }))
);

// His agent's requests and questions (#2257, AC100) load the first time one is asked, outside the JavaScript every view
// loads up front (NFR-PERF-003).
const BrokkPermissions = lazy(() => import("./brokk-permission").then((mod) => ({ default: mod.BrokkPermissions })));

// The spacing of the open window around what it measures (brokk-group.css): the exchange's padding above and below,
// and the composer's margin all around.
const ConvoPadPx = 12 + 4;
const ComposerMarginPx = 8 + 8;

// What the developer was writing when the group hid: it comes back with the group, so Escape never costs a message.
let draft = "";

// The text kept for the next time the field shows; the window stays open for as long as the field holds text (AC22).
export function keepDraft(value: string): void {
    draft = value;
}

// A failure's note goes once the developer writes again; his answer stays until the next message.
function clearsOnTyping(state: TalkState): boolean {
    return state.phase !== "idle" && !onItsWay(state) && keepsText(state);
}

export function BrokkTalk({
    onTyping,
    onFocusChange,
    onContentHeight,
}: {
    onTyping: (typing: boolean) => void;
    // The window opens or folds (AC22): the group's panel gives way above it while it is open.
    onFocusChange?: (open: boolean) => void;
    // What the exchange and the composer need, so that the window is as tall as what it holds.
    onContentHeight?: (height: number) => void;
}) {
    const t = useT();
    const session = BrokkSession.getInstance();
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const state = useAtomValue(session.stateAtom, { store: globalStore });
    const items = useAtomValue(session.exchangeAtom, { store: globalStore });
    const queued = useAtomValue(session.queuedAtom, { store: globalStore });
    const returned = useAtomValue(session.returnedAtom, { store: globalStore });
    // What his agent asks the developer now (#2257, AC100): its card opens his conversation, where it is answered.
    const ask = useAtomValue(session.permissionAtom, { store: globalStore });
    const askGone = useAtomValue(session.permissionGoneAtom, { store: globalStore });
    const approved = useAtomValue(session.approvedAtom, { store: globalStore });
    const [text, setTextState] = useState(draft);
    const [focused, setFocused] = useState(false);
    const [confirming, setConfirming] = useState<InlineAction>(null);
    const [slashKept, setSlashKept] = useState(false);
    // The developer's answers to his agent's question so far, for the question on screen.
    const [picks, setPicks] = useState<{ id: string; picks: QuestionPicks }>({ id: null, picks: {} });
    const [answering, setAnswering] = useState(false);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const composerRef = useRef<HTMLDivElement>(null);
    const setText = (value: string) => {
        keepDraft(value);
        setTextState(value);
    };
    // While the brainstorm is on, his conversation stays open beside his portrait whatever has the focus (FR-BOSS-010,
    // #2257): the mockup's exchange lives in his layer.
    const brainstorming = useAtomValue(BrainstormStateAtom, { store: globalStore })?.open === true;
    const brainstormAllowed = useBrainstormAllowed();
    const asking = ask != null;
    const question = isQuestion(ask) ? ask : null;
    const questionPicks = question != null && picks.id === question.id ? picks.picks : {};
    const openAsk = question != null ? openQuestion(question, questionPicks) : null;
    // A question about the brainstorms (the picker, his offer to resume one, a forget's confirmation) opens it too.
    const prompted = useAtomValue(BrainstormPromptAtom, { store: globalStore }) != null;
    // The way back to the brainstorm last left (FR-BOSS-010 AC10e, #2284).
    const lastLeft = useAtomValue(BrainstormLastLeftAtom, { store: globalStore });
    // A message waiting for him shows in his conversation, with its Cancel (#2284).
    const open = conversationOpen(focused, text) || brainstorming || asking || prompted || queued != null;
    // A Cancel or a failure gives the waiting text back to the field, before what was written meanwhile.
    useEffect(() => {
        if (returned == null) {
            return;
        }
        fireAndForget(async () => {
            const back = await session.takeReturned();
            if (back != null) {
                setText(fieldWithReturned(back, draft));
            }
        });
    }, [returned, session]);
    useEffect(() => onTyping(text.trim() !== ""), [text, onTyping]);
    useEffect(() => () => onTyping(false), [onTyping]);
    useEffect(() => {
        session.setWindowOpen(open);
        onFocusChange?.(open);
    }, [open, session, onFocusChange]);
    useEffect(
        () => () => {
            session.setWindowOpen(false);
            onFocusChange?.(false);
        },
        [session, onFocusChange]
    );
    const last = items[items.length - 1];
    // A question that was asked about a reply is dropped once the exchange moves on.
    useEffect(() => setConfirming(null), [last?.id, last?.role]);

    const noteKey = talkNoteKey(state);
    const wayOut = talkWayOut(state);
    const terminalAside = talkTerminalAside(state);
    // His words are coming in: the domino of "thinking" has done its work.
    const answerShows = last?.role === "brokk" && last.text !== "";
    // The waiting message's row says it in the open window; folded, the note under the field does. A request or a
    // question his window shows is answered there: no note sends the developer to his terminal.
    const showNote =
        noteKey != null &&
        !(state.phase === "answering" && answerShows) &&
        !(state.phase === "needsanswer" && asking) &&
        !(state.phase === "queued" && open && queued != null);

    // The field grows with its lines (AC22b, AC103, #2237): measured at its natural height, then capped at six lines.
    // The open window's field has its own size and leading: it is measured again when the window opens or folds.
    useLayoutEffect(() => {
        const field = inputRef.current;
        if (field == null) {
            return;
        }
        const style = getComputedStyle(field);
        const lineHeight = parseFloat(style.lineHeight);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        if (!Number.isFinite(lineHeight) || !Number.isFinite(padding)) {
            return;
        }
        field.style.height = "auto";
        field.style.height = `${talkFieldHeight(field.scrollHeight, lineHeight, padding)}px`;
    }, [text, open]);

    // The send of the composer: an answer to his agent's open question (AC100), else a message.
    const answerQuestion = async (next: QuestionPicks) => {
        if (question == null) {
            return;
        }
        setPicks({ id: question.id, picks: next });
        const answers = questionAnswers(question, next);
        if (answers == null || answering) {
            return;
        }
        setAnswering(true);
        try {
            await session.answer(question, answers);
        } finally {
            setAnswering(false);
        }
    };

    // An answer given in the window (an authorisation, a reply he offered) keeps the developer in it (#2349): the
    // clicked button leaves or is disabled right after, and the focus it held would drop on the page and fold the
    // window. The focus goes to his field first, where the developer goes on.
    const keepConversation = () => inputRef.current?.focus({ preventScroll: true });

    // clearPrompt: the developer's own click on "Clear his prompt and send" (#2257), the one way text MoltenTerm did not
    // type leaves his prompt.
    const send = async (clearPrompt = false) => {
        if (openAsk != null && !clearPrompt) {
            const typed = text.trim();
            if (typed === "" || typed.length > MaxMessageLength) {
                return;
            }
            setText("");
            await answerQuestion({ ...questionPicks, [openAsk.question]: [typed] });
            return;
        }
        if (!canSend(text, state)) {
            return;
        }
        const action = fieldAction(text, brainstormAllowed);
        if (action.kind === "brainstorm") {
            await startBrainstorm(action.idea);
            return;
        }
        if (action.kind === "slash") {
            setSlashKept(true);
            return;
        }
        const result = await session.say(action.text, { clearPrompt });
        // What the developer wrote while the message waited stays (`draft` is the field as it is now).
        setText(fieldAfterSend(action.text, draft, result));
    };
    // `/brainstorm [idea]` (#2257): the mode opens at once, and the idea, when there is one, goes as the message whose
    // answer puts it at the centre. It stays in the field when his agent could not take it. When one of nearly that title
    // is saved, he asks first, and the idea goes only on Start fresh (#2248).
    const startBrainstorm = async (idea: string) => {
        setText("");
        const sendNow = await openBrainstorm(idea);
        if (idea === "" || !sendNow) {
            return;
        }
        const result = await session.say(idea);
        if (keepsText(result) && draft.trim() === "") {
            setText(idea);
        }
    };
    // A reply he offered goes as the developer's next message. When his agent could not take it, it waits in the field,
    // where the way out of the note (Réessayer) sends it again.
    const sendReply = async (reply: string) => {
        keepConversation();
        if (onItsWay(state)) {
            return;
        }
        const result = await session.say(reply);
        if (keepsText(result) && draft.trim() === "") {
            setText(reply);
        }
    };
    const pick = (action: InlineAction) => {
        keepConversation();
        const outcome = afterClick(action);
        setConfirming(outcome.confirming);
        if (outcome.send != null) {
            void sendReply(outcome.send);
        }
    };
    const confirm = () => {
        keepConversation();
        const outcome = afterConfirm(confirming);
        setConfirming(outcome.confirming);
        if (outcome.send != null) {
            void sendReply(outcome.send);
        }
    };
    const cancel = () => {
        keepConversation();
        setConfirming(afterCancel().confirming);
    };
    const takeWayOut = (way: TalkWayOut) => {
        if (way === "chooseAgent") {
            fireAndForget(() => openSettingsSection("agents"));
            return;
        }
        if (way === "openTerminal" && state.where != null) {
            showPane(state.where);
            return;
        }
        void send(way === "clearAndSend");
    };
    // A text starting with a slash stays in the field (review of #2257): his agent would run it as its own command.
    const slashNote = slashKept ? (
        <div role="status" className="text-11 text-secondary" data-testid="brokk-talk-slash">
            {t("boss.panel.talk.slashKept", { name })}
        </div>
    ) : null;

    // The field's one command, offered while the developer starts a slash (#2257); it has no autocomplete of its own.
    const commandHint =
        openAsk == null && showsCommandHint(text, brainstormAllowed) ? (
            <div className="text-11 text-muted" data-testid="brokk-talk-command">
                {t("boss.panel.talk.commandHint", { name })}
            </div>
        ) : null;
    // The way back to the brainstorm left (AC10e), as the resume card in both windows (#2303).
    const resumeLine =
        lastLeft != null && brainstormAllowed && !brainstorming ? (
            <ResumeCard
                eyebrow={t("boss.brainstorm.card.lastLeft")}
                title={lastLeft.title}
                label={t("boss.brainstorm.card.lastLeftLabel", { title: lastLeft.title })}
                testIds={{
                    card: "brokk-talk-resume",
                    resume: "brokk-talk-resume-go",
                    dismiss: "brokk-talk-resume-dismiss",
                }}
                onResume={() => fireAndForget(() => resumeLastBrainstorm())}
                onDismiss={dismissLastBrainstorm}
            />
        ) : null;
    const note = showNote ? (
        <div
            role="status"
            data-testid="brokk-talk-note"
            data-phase={state.phase}
            className={cn(
                "flex flex-wrap items-center gap-x-2 text-11",
                talkWaits(state) ? "text-muted" : "text-secondary"
            )}
        >
            <span>
                {talkWaits(state) ? <DominoLoader className="mr-1.5" /> : null}
                {t(noteKey, { name, agent: state.agentName })}
            </span>
            {wayOut != null ? (
                <button
                    type="button"
                    data-testid="brokk-talk-wayout"
                    data-way={wayOut}
                    onClick={() => takeWayOut(wayOut)}
                    className="cursor-pointer rounded-4 border border-border px-1.5 py-0.5 text-11 text-primary hover:bg-hover"
                >
                    {t(talkWayOutKey(wayOut), { name })}
                </button>
            ) : null}
            {terminalAside ? (
                <button
                    type="button"
                    data-testid="brokk-talk-terminal"
                    onClick={() => takeWayOut("openTerminal")}
                    className="cursor-pointer text-11 text-muted underline-offset-2 hover:text-secondary hover:underline"
                >
                    {t("boss.panel.talk.openTerminal", { name })}
                </button>
            ) : null}
        </div>
    ) : null;
    const asks = asking || askGone || approved.length > 0;
    // Nothing said yet, nothing on its way, nothing asked: the open window is only the composer (AC102).
    const convoShown =
        open &&
        (items.length > 0 ||
            queued != null ||
            asks ||
            prompted ||
            note != null ||
            slashNote != null ||
            commandHint != null ||
            resumeLine != null);

    // The window is as tall as what it holds (AC102, AC104): the exchange's content and the composer, with their
    // spacing; the group adds the frame. What grows in the exchange (a card that loads after it, an answer coming in)
    // keeps the latest in view.
    useLayoutEffect(() => {
        const composer = composerRef.current;
        if (!open || composer == null) {
            return;
        }
        const report = () => {
            const convo = convoShown ? (innerRef.current?.offsetHeight ?? 0) + ConvoPadPx : 0;
            onContentHeight?.(convo + composer.offsetHeight + ComposerMarginPx);
            const scroll = scrollRef.current;
            if (scroll != null) {
                scroll.scrollTop = scroll.scrollHeight;
            }
        };
        report();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(report);
        observer.observe(composer);
        if (innerRef.current != null) {
            observer.observe(innerRef.current);
        }
        return () => observer.disconnect();
    }, [open, convoShown, onContentHeight]);
    // The latest message stays in view (AC104).
    useEffect(() => {
        const scroll = scrollRef.current;
        if (open && scroll != null) {
            scroll.scrollTop = scroll.scrollHeight;
        }
    }, [open, convoShown, items, state.phase, confirming, text, ask, queued]);

    // Folded, the field keeps its one row with the button at its end; open, the button stands at the end of the
    // composer's row of controls (AC103). The molten call to action, led by its icon; with nothing to send it is calm,
    // not a dimmed orange (AC91a, #2303, brokk-group.css).
    const sendable = openAsk != null ? text.trim() !== "" && !answering : canSend(text, state);
    const sendButton = (
        <button
            type="submit"
            disabled={!sendable}
            data-testid="brokk-talk-send"
            aria-label={t("boss.panel.talk.send")}
            title={t("boss.panel.talk.send")}
            className="molten-btn mt-brokk-send inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-6 px-2.5 py-0.5 text-11 font-medium"
        >
            <i className={makeIconClass("paper-plane", false)} aria-hidden />
            {open ? null : t("boss.panel.talk.send")}
            <MoltenWave />
        </button>
    );
    const fieldRow = (
        <div className="mt-brokk-field-row">
            <textarea
                ref={inputRef}
                rows={1}
                value={text}
                maxLength={MaxMessageLength}
                placeholder={
                    openAsk != null
                        ? t("boss.panel.talk.question.placeholder", { name })
                        : t("boss.panel.talk.placeholder", { name })
                }
                title={brainstormAllowed ? t("boss.panel.talk.keysBrainstorm") : t("boss.panel.talk.keys")}
                aria-label={t("boss.panel.talk.label", { name })}
                data-testid="brokk-talk-input"
                className="mt-brokk-field-input"
                onChange={(e) => {
                    setText(e.target.value);
                    setSlashKept(false);
                    if (clearsOnTyping(state)) {
                        session.clearNote();
                    }
                }}
                onKeyDown={(e) => {
                    if (!sendsOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
                        return;
                    }
                    e.preventDefault();
                    void send();
                }}
            />
            {open ? null : sendButton}
        </div>
    );

    return (
        <form
            className="mt-brokk-field"
            data-testid="brokk-talk"
            data-open={open ? "true" : "false"}
            data-convo={convoShown ? "true" : undefined}
            onSubmit={(e) => {
                e.preventDefault();
                void send();
            }}
            onFocus={() => setFocused(true)}
            // The focus moving from the input to a button is still the conversation.
            onBlur={(e) => setFocused(e.currentTarget.contains(e.relatedTarget as Node))}
        >
            {convoShown ? (
                <div
                    ref={scrollRef}
                    className="mt-brokk-convo"
                    // A click in the exchange (to select a word) keeps the focus in the conversation.
                    tabIndex={-1}
                    role="log"
                    aria-live="polite"
                    aria-label={t("boss.panel.talk.window", { name })}
                    data-testid="brokk-convo"
                >
                    <div ref={innerRef} className="mt-brokk-convo-inner">
                        <ExchangeView
                            items={items}
                            name={name}
                            confirming={confirming}
                            busy={onItsWay(state)}
                            onPick={pick}
                            onConfirm={confirm}
                            onCancel={cancel}
                        />
                        {queued != null ? (
                            <div className="mt-brokk-msg" data-role="you" data-testid="brokk-queued">
                                <span className="sr-only">{t("boss.panel.talk.you")}: </span>
                                <div className="mt-brokk-msg-text opacity-70">{queued.text}</div>
                                <div role="status" className="flex flex-wrap items-center gap-x-2 text-11 text-muted">
                                    <span>
                                        <DominoLoader className="mr-1.5" />
                                        {t("boss.panel.talk.queuedRow", { name })}
                                    </span>
                                    <button
                                        type="button"
                                        data-testid="brokk-queued-cancel"
                                        onClick={() => session.cancelQueued()}
                                        className="cursor-pointer rounded-4 border border-border px-1.5 py-0.5 text-11 text-primary hover:bg-hover"
                                    >
                                        {t("boss.panel.talk.cancelQueued")}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        {asks ? (
                            <Suspense fallback={null}>
                                <BrokkPermissions
                                    name={name}
                                    onAnswer={keepConversation}
                                    picks={questionPicks}
                                    answering={answering}
                                    onPicks={(next, sendNow) => {
                                        keepConversation();
                                        if (sendNow) {
                                            void answerQuestion(next);
                                            return;
                                        }
                                        setPicks({ id: question?.id ?? null, picks: next });
                                    }}
                                    onSendPicks={() => {
                                        keepConversation();
                                        void answerQuestion(questionPicks);
                                    }}
                                />
                            </Suspense>
                        ) : null}
                        {prompted ? (
                            <Suspense fallback={null}>
                                <BrainstormPrompts name={name} />
                            </Suspense>
                        ) : null}
                        {note}
                        {slashNote}
                        {commandHint}
                        {resumeLine}
                    </div>
                </div>
            ) : null}
            {/* Open, the field and its row of controls are one compact well that shows the focus (AC91a, AC103). The
                well is there folded too, laid out as if it were not (brokk-group.css): the field keeps its place in
                the tree, so opening the window never remounts it and never takes its focus. */}
            <div ref={composerRef} className="mt-brokk-composer" data-testid="brokk-talk-composer">
                {fieldRow}
                {open ? (
                    <div className="mt-brokk-field-foot" data-testid="brokk-talk-foot">
                        <span className="mt-brokk-field-hint" data-testid="brokk-talk-hint">
                            {openAsk != null ? t("boss.panel.talk.question.answering", { name }) : null}
                        </span>
                        {sendButton}
                    </div>
                ) : null}
            </div>
            {!open && (note != null || slashNote != null || commandHint != null || resumeLine != null) ? (
                <div className="mt-brokk-field-extra">
                    {note}
                    {slashNote}
                    {commandHint}
                    {resumeLine}
                </div>
            ) : null}
        </form>
    );
}
