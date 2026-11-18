// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// His agent's permission requests and questions in his talk window (#2257, AC100, AC101, #2382): what is asked in plain
// words, the exact command, path or tool, and the developer's answer (Allow once, Always allow when his agent offers
// it, Deny), sent to that request alone (pkg/molten/brokksession/permit.go). A question shows its choices as buttons;
// any other answer is written in the composer. The approvals boss:autoapprove made show as lines, so nothing runs
// unseen. It loads the first time one shows (brokk-talk.tsx).

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { BrokkSession } from "./brokk-session";
import {
    AgentQuestion,
    AutoApproval,
    isQuestion,
    PermissionAsk,
    permitChoices,
    PermitDecision,
    PermitStatus,
    questionAnswers,
    QuestionPicks,
    sendsOnPick,
    withPick,
} from "./brokk-talk-model";

const DecisionKeys: Record<PermitDecision, string> = {
    allow: "boss.panel.talk.permission.allow",
    always: "boss.panel.talk.permission.always",
    deny: "boss.panel.talk.permission.deny",
};

// The developer's answer keeps them in his conversation (#2349). The clicked button is disabled, then leaves with its
// card once the request is answered: holding the focus, it would drop it on the page, and the window, which stays
// open while its field has the focus, would fold. So the focus goes back to his field first, before anything leaves.
export async function answerPermission(
    ask: PermissionAsk,
    decision: PermitDecision,
    keepConversation: () => void
): Promise<PermitStatus> {
    keepConversation();
    return BrokkSession.getInstance().permit(ask, decision);
}

export function BrokkPermissionCard({
    ask,
    name,
    onAnswer,
}: {
    ask: PermissionAsk;
    name: string;
    onAnswer: () => void;
}) {
    const t = useT();
    const [sending, setSending] = useState(false);
    const answer = async (decision: PermitDecision) => {
        if (sending) {
            return;
        }
        setSending(true);
        try {
            await answerPermission(ask, decision, onAnswer);
        } finally {
            setSending(false);
        }
    };
    return (
        <div
            role="group"
            aria-label={t(`boss.panel.talk.permission.kind.${ask.kind}`, { name })}
            data-testid="brokk-permission"
            data-kind={ask.kind}
            className="flex flex-col gap-1.5 rounded-4 border border-border p-2 text-12"
        >
            <span className="text-secondary">{t(`boss.panel.talk.permission.kind.${ask.kind}`, { name })}</span>
            <code
                data-testid="brokk-permission-subject"
                className="block max-h-24 overflow-auto rounded-4 bg-black/20 px-1.5 py-1 font-mono text-11 break-all whitespace-pre-wrap text-primary"
            >
                {ask.subject}
            </code>
            <span className="inline-flex flex-wrap justify-end gap-1.5">
                {permitChoices(ask).map((decision) => (
                    <button
                        key={decision}
                        type="button"
                        disabled={sending}
                        data-testid={`brokk-permission-${decision}`}
                        onClick={() => void answer(decision)}
                        className={
                            decision === "allow"
                                ? "molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                                : "cursor-pointer rounded-4 border border-border px-2 py-0.5 text-11 text-primary hover:bg-hover"
                        }
                    >
                        {t(DecisionKeys[decision])}
                        {decision === "allow" ? <MoltenWave /> : null}
                    </button>
                ))}
            </span>
        </div>
    );
}

// One question of his agent: its header and its text, then its choices. A pick of a choice the developer wrote in the
// composer shows as their answer.
function QuestionItem({
    question,
    picked,
    disabled,
    onPick,
}: {
    question: AgentQuestion;
    picked: string[];
    disabled: boolean;
    onPick: (label: string) => void;
}) {
    const t = useT();
    const labels = new Set(question.options.map((o) => o.label));
    const written = picked.filter((p) => !labels.has(p));
    return (
        <div className="mt-brokk-question-item" data-testid="brokk-question-item">
            {question.header ? <span className="mt-brokk-question-header">{question.header}</span> : null}
            <p className="mt-brokk-question-text">{question.question}</p>
            <div className="mt-brokk-question-choices" role="group" aria-label={question.question}>
                {question.options.map((option) => {
                    const on = picked.includes(option.label);
                    return (
                        <button
                            key={option.label}
                            type="button"
                            disabled={disabled}
                            aria-pressed={on}
                            data-testid="brokk-question-choice"
                            onClick={() => onPick(option.label)}
                            className={cn("mt-brokk-choice cursor-pointer", on && "mt-selected-action")}
                        >
                            <span className="mt-brokk-choice-label">{option.label}</span>
                            {option.description ? (
                                <span className="mt-brokk-choice-detail">{option.description}</span>
                            ) : null}
                        </button>
                    );
                })}
            </div>
            {written.length > 0 ? (
                <span className="mt-brokk-question-yours" data-testid="brokk-question-yours">
                    {t("boss.panel.talk.question.yours", { answer: written.join(", ") })}
                </span>
            ) : null}
        </div>
    );
}

// His agent's question (AC100): inline in the conversation, where it was asked. One choice answers at once; a question
// with several choices, or several questions, are sent with Send once each has an answer.
export function BrokkQuestionCard({
    ask,
    name,
    picks,
    answering,
    onPicks,
    onSend,
}: {
    ask: PermissionAsk;
    name: string;
    picks: QuestionPicks;
    answering: boolean;
    // sendNow: the pick completes a question that takes one choice, so the answers go at once.
    onPicks: (picks: QuestionPicks, sendNow: boolean) => void;
    onSend: () => void;
}) {
    const t = useT();
    const needsSend = ask.questions.length > 1 || ask.questions.some((q) => q.multiselect);
    const complete = questionAnswers(ask, picks) != null;
    return (
        <div
            role="group"
            aria-label={t("boss.panel.talk.question.label", { name })}
            data-testid="brokk-question"
            className="mt-brokk-question"
        >
            <span className="mt-brokk-question-eyebrow">{t("boss.panel.talk.question.asks", { name })}</span>
            {ask.questions.map((question) => (
                <QuestionItem
                    key={question.question}
                    question={question}
                    picked={picks[question.question] ?? []}
                    disabled={answering}
                    onPick={(label) => {
                        const next = withPick(picks, question, label);
                        onPicks(next, !needsSend && sendsOnPick(ask, question, next));
                    }}
                />
            ))}
            <div className="mt-brokk-question-foot">
                <span className="mt-brokk-question-hint">{t("boss.panel.talk.question.hint")}</span>
                {needsSend ? (
                    <button
                        type="button"
                        disabled={!complete || answering}
                        data-testid="brokk-question-send"
                        onClick={onSend}
                        className="molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                    >
                        {t("boss.panel.talk.question.send")}
                        <MoltenWave />
                    </button>
                ) : null}
            </div>
        </div>
    );
}

export function BrokkApprovedLines({ approved, name }: { approved: AutoApproval[]; name: string }) {
    const t = useT();
    if (approved.length === 0) {
        return null;
    }
    return (
        <ul className="flex flex-col gap-0.5 text-11 text-muted" data-testid="brokk-approved">
            {approved.map((a) => (
                <li key={a.id} data-testid="brokk-approved-line">
                    {t("boss.panel.talk.permission.autoApproved", { name })}{" "}
                    <code className="font-mono text-secondary break-all">{a.subject}</code>
                </li>
            ))}
        </ul>
    );
}

// What the talk window shows of his agent's requests: the waiting one (a permission or a question), the note of an
// answer that came too late, and the approvals made without asking.
export function BrokkPermissions({
    name,
    onAnswer,
    picks,
    answering,
    onPicks,
    onSendPicks,
}: {
    name: string;
    onAnswer: () => void;
    picks: QuestionPicks;
    answering: boolean;
    onPicks: (picks: QuestionPicks, sendNow: boolean) => void;
    onSendPicks: () => void;
}) {
    const t = useT();
    const session = BrokkSession.getInstance();
    const ask = useAtomValue(session.permissionAtom, { store: globalStore });
    const gone = useAtomValue(session.permissionGoneAtom, { store: globalStore });
    const approved = useAtomValue(session.approvedAtom, { store: globalStore });
    return (
        <>
            <BrokkApprovedLines approved={approved} name={name} />
            {ask != null && isQuestion(ask) ? (
                <BrokkQuestionCard
                    ask={ask}
                    name={name}
                    picks={picks}
                    answering={answering}
                    onPicks={onPicks}
                    onSend={onSendPicks}
                />
            ) : null}
            {ask != null && !isQuestion(ask) ? <BrokkPermissionCard ask={ask} name={name} onAnswer={onAnswer} /> : null}
            {ask == null && gone ? (
                <div role="status" className="text-11 text-secondary" data-testid="brokk-permission-gone">
                    {t("boss.panel.talk.permission.gone", { name })}
                </div>
            ) : null}
        </>
    );
}
