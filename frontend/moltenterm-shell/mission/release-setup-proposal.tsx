// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent's help in the release setup (#1099, FR-MC-039): the developer says what they want in their words, the
// project's coding agent answers with step changes (never a file), and each change is a card the developer ticks; the
// review's diff follows the ticks. Any agentic CLI works: the project's agent when MoltenTerm has a read-only form of it,
// any other one through "Copy the request" and "Paste its answer". Nothing is written by any of it.

import { cn, fireAndForget } from "@/util/util";
import { useRef, useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { DominoLoader } from "../suite/suite";
import { setupApply, setupPrompt, setupRefine } from "./release-setup-client";
import type { SetupProposalResult, SetupRefined, SetupStepChange } from "./release-setup-model";

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const InputClass =
    "w-full resize-y rounded-4 border border-border bg-transparent px-2 py-1.5 text-12 text-primary placeholder:text-muted focus:border-accent/60 focus:outline-none";

function ChangeCard({
    change,
    chosen,
    disabled,
    onChoose,
}: {
    change: SetupStepChange;
    chosen: boolean;
    disabled: boolean;
    onChoose: (on: boolean) => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const title = change.op === "versions" ? t("mc.setup.update.versionsTitle") : change.title || change.id;
    return (
        <li
            className="flex flex-col gap-1.5 rounded-4 border border-border px-2.5 py-2"
            data-testid={`proposal-change-${change.key}`}
        >
            <div className="flex flex-wrap items-center gap-2">
                <input
                    type="checkbox"
                    className="cursor-pointer"
                    checked={chosen}
                    disabled={disabled}
                    onChange={(e) => onChoose(e.target.checked)}
                    aria-label={t("mc.setup.proposal.take", { title })}
                    data-testid={`proposal-take-${change.key}`}
                />
                <span
                    className={cn(
                        "rounded-full border px-1.5 text-11 leading-4",
                        change.op === "add" && "border-success/50 text-success",
                        change.op === "remove" && "border-error/50 text-danger",
                        (change.op === "change" || change.op === "versions") && "border-accent/50 text-accent"
                    )}
                >
                    {t(`mc.setup.proposal.op.${change.op}`)}
                </span>
                {change.channel ? (
                    <span className="text-11 text-muted">{t(`mc.setup.update.group.${change.channel}`)}</span>
                ) : null}
                <span className="min-w-0 flex-1 text-12 text-primary">{title}</span>
                <button
                    type="button"
                    className="cursor-pointer text-11 text-muted hover:text-primary"
                    onClick={() => setOpen(!open)}
                >
                    {open ? t("mc.setup.update.hide") : t("mc.setup.update.show")}
                </button>
            </div>
            {change.after || change.before ? (
                <p className="text-11 text-muted">
                    {change.after
                        ? t("mc.setup.proposal.after", { id: change.after })
                        : t("mc.setup.proposal.before", { id: change.before })}
                </p>
            ) : null}
            {change.why ? <p className="text-11 text-secondary">{change.why}</p> : null}
            {open ? (
                <div className="grid gap-2 @min-[40rem]:grid-cols-2">
                    {change.oldtext ? (
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-11 text-muted uppercase">{t("mc.setup.update.before")}</span>
                            <pre className="overflow-auto rounded-4 bg-black/30 p-2 font-mono text-11 whitespace-pre-wrap text-secondary">
                                {change.oldtext}
                            </pre>
                        </div>
                    ) : null}
                    {change.newtext ? (
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-11 text-muted uppercase">{t("mc.setup.update.after")}</span>
                            <pre className="overflow-auto rounded-4 bg-black/30 p-2 font-mono text-11 whitespace-pre-wrap text-secondary">
                                {change.newtext}
                            </pre>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </li>
    );
}

export function ProposalCards({
    refined,
    chosen,
    applying,
    onChoose,
    onDrop,
}: {
    refined: SetupRefined;
    chosen: string[];
    applying: boolean;
    onChoose: (key: string, on: boolean) => void;
    onDrop: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const by = refined.agentname || t("mc.setup.proposal.otherAgent");
    const count = refined.changes.length;
    return (
        <div className="flex flex-col gap-2 rounded-6 border border-accent/40 p-3" data-testid="setup-proposal">
            <div className="flex flex-wrap items-center gap-2 text-12">
                <span className="rounded-full border border-accent/60 bg-accent/15 px-2 text-11 leading-5 text-accent">
                    {t("mc.setup.proposal.pill")}
                </span>
                <span className="text-secondary">
                    {count === 0
                        ? t("mc.setup.proposal.none", { agent: by })
                        : tCount("mc.setup.proposal.count", count, { agent: by })}
                </span>
                {count > 0 ? (
                    <span className="text-11 text-muted" data-testid="setup-proposal-chosen">
                        {t("mc.setup.proposal.chosen", { chosen: chosen.length, count })}
                    </span>
                ) : null}
                {applying ? <DominoLoader /> : null}
                <button type="button" className={cn(PlainButton, "ml-auto py-1 text-11")} onClick={onDrop}>
                    {t("mc.setup.proposal.drop")}
                </button>
            </div>
            {refined.changes.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                    {refined.changes.map((c) => (
                        <ChangeCard
                            key={c.key}
                            change={c}
                            chosen={chosen.includes(c.key)}
                            disabled={applying}
                            onChoose={(on) => onChoose(c.key, on)}
                        />
                    ))}
                </ul>
            ) : null}
            {refined.rejected.length > 0 ? (
                <details className="rounded-4 border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-11 text-secondary">
                    <summary className="cursor-pointer text-12 text-warning" data-testid="setup-proposal-rejected">
                        {tCount("mc.setup.proposal.rejectedTitle", refined.rejected.length)}
                    </summary>
                    <ul className="mt-1 flex flex-col gap-1">
                        {refined.rejected.map((r, i) => (
                            <li key={i} className="flex flex-col gap-0.5">
                                <span>{t(`mc.setup.proposal.rejected.${r.code}`, { detail: r.detail ?? "" })}</span>
                                <span className="font-mono text-muted wrap-anywhere">{r.text}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </div>
    );
}

export function AgentProposal({
    dir,
    draftText,
    onResult,
    onBusy,
}: {
    dir: string;
    draftText: string;
    // The draft with the ticked changes; null: back to the draft.
    onResult: (result: SetupProposalResult) => void;
    onBusy: (busy: boolean) => void;
}) {
    const t = useT();
    const [request, setRequest] = useState("");
    const [pasted, setPasted] = useState("");
    const [other, setOther] = useState(false);
    const [refined, setRefined] = useState<SetupRefined>(null);
    const [chosen, setChosen] = useState<string[]>([]);
    const [asking, setAsking] = useState(false);
    const [applying, setApplying] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string>(null);
    const applyRun = useRef(0);

    const busy = (on: boolean) => {
        setAsking(on);
        onBusy(on);
    };
    const ask = (answer?: string) =>
        fireAndForget(async () => {
            busy(true);
            setError(null);
            try {
                const r = await setupRefine(dir, draftText, request, answer);
                setRefined(r);
                setChosen(r.changes.map((c) => c.key));
                onResult({ ...r, agentname: r.agentname || t("mc.setup.proposal.otherAgent") });
                setPasted("");
            } catch (e) {
                setError(serverErrorText(e));
                if (!answer) {
                    setOther(true);
                }
            } finally {
                busy(false);
            }
        });
    const choose = (key: string, on: boolean) =>
        fireAndForget(async () => {
            const next = refined.changes.map((c) => c.key).filter((k) => (k === key ? on : chosen.includes(k)));
            setChosen(next);
            const n = ++applyRun.current;
            setApplying(true);
            onBusy(true);
            try {
                const applied = await setupApply(dir, draftText, refined.changes, next);
                if (n === applyRun.current) {
                    onResult({ ...applied, agentname: refined.agentname || t("mc.setup.proposal.otherAgent") });
                    setError(null);
                }
            } catch (e) {
                if (n === applyRun.current) {
                    setError(serverErrorText(e));
                }
            } finally {
                if (n === applyRun.current) {
                    setApplying(false);
                    onBusy(false);
                }
            }
        });
    const drop = () => {
        applyRun.current++;
        setApplying(false);
        onBusy(false);
        setRefined(null);
        setChosen([]);
        setError(null);
        onResult(null);
    };
    const copy = () =>
        fireAndForget(async () => {
            setError(null);
            try {
                const answer = await setupPrompt(dir, draftText, request);
                await navigator.clipboard.writeText(answer.prompt);
                setCopied(true);
            } catch (e) {
                setError(serverErrorText(e));
            }
        });

    if (refined != null) {
        return (
            <div className="flex flex-col gap-2">
                <ProposalCards
                    refined={refined}
                    chosen={chosen}
                    applying={applying}
                    onChoose={choose}
                    onDrop={drop}
                />
                {error ? (
                    <p className="text-11 text-danger" role="alert">
                        {error}
                    </p>
                ) : null}
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-6 border border-border p-3" data-testid="setup-ask">
            <label className="flex flex-col gap-1 text-12 text-secondary">
                {t("mc.setup.proposal.wordsLabel")}
                <textarea
                    className={InputClass}
                    rows={2}
                    value={request}
                    onChange={(e) => setRequest(e.target.value)}
                    placeholder={t("mc.setup.proposal.wordsPlaceholder")}
                    data-testid="setup-request"
                />
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    disabled={asking}
                    className={cn(PlainButton, "inline-flex items-center py-1 text-11")}
                    onClick={() => ask()}
                    data-testid="setup-refine"
                    title={t("mc.setup.review.refineTitle")}
                >
                    {asking && !other ? (
                        <DominoLoader className="mr-1.5" />
                    ) : (
                        <i className="fa fa-solid fa-wand-magic-sparkles mr-1.5 text-11" />
                    )}
                    {asking && !other ? t("mc.setup.review.refining") : t("mc.setup.proposal.ask")}
                </button>
                <span className="text-11 text-muted">{t("mc.setup.proposal.askNote")}</span>
                <button
                    type="button"
                    className="ml-auto cursor-pointer text-11 text-muted hover:text-primary"
                    onClick={() => setOther(!other)}
                    data-testid="setup-other-agent"
                >
                    {other ? t("mc.setup.proposal.otherHide") : t("mc.setup.proposal.otherShow")}
                </button>
            </div>
            {error ? (
                <p className="text-11 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
            {other ? (
                <div className="flex flex-col gap-1.5 border-t border-border pt-2" data-testid="setup-paste">
                    <p className="text-11 text-secondary">{t("mc.setup.proposal.otherText")}</p>
                    <div className="flex items-center gap-2">
                        <button type="button" className={cn(PlainButton, "py-1 text-11")} onClick={copy}>
                            {t("mc.setup.proposal.copy")}
                        </button>
                        {copied ? <span className="text-11 text-success">{t("mc.setup.proposal.copied")}</span> : null}
                    </div>
                    <textarea
                        className={cn(InputClass, "font-mono text-11")}
                        rows={4}
                        value={pasted}
                        onChange={(e) => setPasted(e.target.value)}
                        placeholder={t("mc.setup.proposal.pastePlaceholder")}
                        data-testid="setup-pasted"
                    />
                    <div>
                        <button
                            type="button"
                            disabled={asking || pasted.trim() === ""}
                            className={cn(PlainButton, "py-1 text-11")}
                            onClick={() => ask(pasted)}
                            data-testid="setup-read-pasted"
                        >
                            {t("mc.setup.proposal.read")}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
