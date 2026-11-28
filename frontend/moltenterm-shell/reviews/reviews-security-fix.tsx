// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The security fix block at the top of the Integration list (FR-REV-036 AC17, #2591; mockup of #2511): the failed dependency
// scan that is not any pull request's own, with its advisories, and where its fix stands. Four steps in the mockup (the
// first-time ask, the fix at work, ready to merge, after the merge) and the ones a fix has besides (waiting for a place,
// needing the developer, stopped, failed). What it draws is security-fix-panel-model.ts's; what its buttons do is
// security-fix-block-actions.ts's, through the calls wavesrv checks. The orange button is the panel's one filled action,
// and the block holds it only while it needs the developer (ask, ready, needs you, failed). Numbers are PR numbers, as
// GitHub and the Validate sheet name them, each a link to its card.

import { cn, fireAndForget } from "@/util/util";
import {
    ArrowRight,
    Bot,
    CircleStop,
    ExternalLink,
    Hourglass,
    LockOpen,
    ShieldAlert,
    ShieldCheck,
    X,
    type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { codingAgentName } from "../coding-agent/coding-agent";
import { getLocale, t as translate, useLocale, useT, useTCount, type TFunction } from "../i18n/i18n";
import { useWordPhrase, type Phrase } from "../i18n/phrase";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { showPanel } from "../review/review-panels";
import { StateMark, type StateMarkKind } from "../state-mark";
import { DominoLoader } from "../suite/suite";
import { CalmButton, MoltenButton } from "./reviews-card";
import { isLocalCheck, type ReviewPr, type ReviewsAnswer } from "./reviews-model";
import type { SecurityAdvisory } from "./reviews-security-model";
import { durationText } from "./reviews-upcoming-model";
import { launchSecurityFix, stopSecurityFixOf } from "./security-fix-block-actions";
import { isSecurityFixStoppable, type SecurityFix } from "./security-fix-model";
import {
    securityUnblockRows,
    type SecurityBlockStep,
    type SecurityFixBlockView,
    type SecurityUnblockRow,
} from "./security-fix-panel-model";

const GhostButton =
    "flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-6 border border-transparent px-2.5 text-12 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary";

// A small control keeps its drawn size and gets a hit area of at least 24 px around it.
const HitArea = "relative before:absolute before:-inset-x-1 before:-inset-y-1 before:content-['']";

// The block's edge by step, as a card's rail says it by heat: blocked ember, at work glowing at 60 %, waiting for the
// developer violet, ready patina, the rest a line.
const StepLines: Record<SecurityBlockStep, string> = {
    ask: "shadow-[inset_3px_0_0_var(--mt-state-blocked)]",
    failed: "shadow-[inset_3px_0_0_var(--mt-state-blocked)]",
    waiting: "shadow-[inset_3px_0_0_var(--mt-line-2)]",
    working: "shadow-[inset_3px_0_0_color-mix(in_srgb,var(--mt-state-running)_60%,transparent)]",
    needsyou: "shadow-[inset_3px_0_0_var(--mt-state-waiting)]",
    ready: "shadow-[inset_3px_0_0_var(--mt-state-ready)]",
    merged: "shadow-[inset_3px_0_0_var(--mt-line-2)]",
    stopped: "shadow-[inset_3px_0_0_var(--mt-line-2)]",
};

const StepIcons: Record<Exclude<SecurityBlockStep, "working">, { icon: LucideIcon; tone: string }> = {
    ask: { icon: ShieldAlert, tone: "text-[var(--mt-state-blocked)]" },
    failed: { icon: ShieldAlert, tone: "text-[var(--mt-state-blocked)]" },
    waiting: { icon: Hourglass, tone: "text-secondary" },
    needsyou: { icon: Bot, tone: "text-[var(--mt-state-waiting)]" },
    ready: { icon: ShieldCheck, tone: "text-[var(--mt-state-ready)]" },
    merged: { icon: LockOpen, tone: "text-secondary" },
    stopped: { icon: CircleStop, tone: "text-muted" },
};

function prList(numbers: readonly number[]): string {
    return numbers.map((n) => `#${n}`).join(", ");
}

function Tile({ step }: { step: SecurityBlockStep }) {
    const running = step === "working";
    const entry = running ? null : StepIcons[step];
    const Icon = entry?.icon;
    return (
        <div
            className={cn(
                "grid h-[28px] w-[28px] shrink-0 place-items-center rounded-4 border border-[var(--mt-line-2)] bg-[var(--mt-surface-3)]",
                running ? "text-[var(--mt-state-running)]" : entry.tone
            )}
            data-testid="reviews-security-fix-tile"
        >
            {running ? (
                <span className="inline-flex scale-75" aria-hidden>
                    <DominoLoader />
                </span>
            ) : (
                <Icon size={16} strokeWidth={2} aria-hidden />
            )}
        </div>
    );
}

// The module as the mockup writes it: the Go module's path says what it is, any other ecosystem is named when the set
// holds several.
function moduleText(advisory: SecurityAdvisory, mixed: boolean): string {
    const name = advisory.package ?? "";
    const ecosystem = (advisory.ecosystem ?? "").trim();
    if (!mixed || ecosystem === "" || ecosystem.toLowerCase() === "go" || name === "") {
        return name || ecosystem;
    }
    return `${ecosystem} · ${name}`;
}

function versionText(advisory: SecurityAdvisory): string {
    if (advisory.version && advisory.fixed) {
        return `${advisory.version} → ${advisory.fixed}`;
    }
    return advisory.fixed || advisory.version || "—";
}

// The advisories: what each is, which module, and from which version to which (the fixed one is what the fix raises).
function AdvisoryTable({
    advisories,
    raised,
    review,
}: {
    advisories: readonly SecurityAdvisory[];
    // The pull request's bump: the last column says what it raises, not what is installed.
    raised?: boolean;
    // The fix records a review instead of raising versions (it says "not applicable").
    review?: boolean;
}) {
    const t = useT();
    const ecosystems = new Set(advisories.map((a) => (a.ecosystem ?? "").toLowerCase()).filter(Boolean));
    const mixed = ecosystems.size > 1;
    return (
        <table
            className="w-full border-collapse text-11"
            aria-label={raised ? t("reviews.securityFix.table.ariaRaised") : t("reviews.securityFix.table.aria")}
            data-testid="reviews-security-fix-advisories"
        >
            <thead>
                <tr className="text-left text-muted">
                    <th className="border-b border-[var(--mt-line-1)] py-[3px] pr-2 font-medium">
                        {t("reviews.securityFix.table.advisory")}
                    </th>
                    <th className="border-b border-[var(--mt-line-1)] py-[3px] pr-2 font-medium">
                        {t("reviews.securityFix.table.module")}
                    </th>
                    <th className="border-b border-[var(--mt-line-1)] py-[3px] pr-2 font-medium">
                        {review
                            ? t("reviews.securityFix.table.review")
                            : raised
                              ? t("reviews.securityFix.table.raised")
                              : t("reviews.securityFix.table.version")}
                    </th>
                </tr>
            </thead>
            <tbody>
                {advisories.map((advisory) => (
                    <tr key={advisory.id} className="text-secondary [&:last-child>td]:border-b-0">
                        <td className="border-b border-[var(--mt-line-1)] py-[3px] pr-2 align-top font-mono whitespace-nowrap text-primary">
                            {advisory.id}
                        </td>
                        <td className="border-b border-[var(--mt-line-1)] py-[3px] pr-2 align-top">
                            {moduleText(advisory, mixed)}
                        </td>
                        <td className="border-b border-[var(--mt-line-1)] py-[3px] pr-2 align-top font-mono whitespace-nowrap">
                            {review ? t("reviews.securityFix.table.notApplicable") : versionText(advisory)}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

// The pull requests the block holds or its fix's merge unblocks, each a link to its card.
function PrLinks({ numbers, onGo }: { numbers: readonly number[]; onGo: (number: number) => void }) {
    const t = useT();
    return (
        <>
            {numbers.map((number) => (
                <button
                    key={number}
                    type="button"
                    onClick={() => onGo(number)}
                    title={t("reviews.securityFix.goToCard", { number })}
                    className={cn(
                        "inline-flex cursor-pointer items-center rounded-4 border border-[var(--mt-line-2)] px-[5px] text-11 leading-4 text-primary hover:bg-hover",
                        HitArea
                    )}
                    data-testid="reviews-security-fix-pr"
                >
                    #{number}
                </button>
            ))}
        </>
    );
}

function agentNameOf(fix: SecurityFix): string {
    return fix?.agentname || translate("reviews.securityFix.anAgent");
}

// The sentence under the title of an ask or a fix at work: how many advisories hold what, then what the agent does.
function blocksSentence(
    tc: (key: string, count: number, vars?: Record<string, string | number>) => string,
    view: SecurityFixBlockView,
    trunk: string
): string {
    const count = view.advisories.length;
    if (view.prs.length === 0) {
        return tc("reviews.securityFix.blocksTrunk", count, { count, trunk });
    }
    return tc("reviews.securityFix.blocks", count, { count, trunk, prs: prList(view.prs) });
}

function workingSentence(fix: SecurityFix): string {
    const name = agentNameOf(fix);
    if (fix.external) {
        return translate("reviews.securityFix.working.external");
    }
    if (fix.resolution === "bump") {
        return translate("reviews.securityFix.working.bump", { name });
    }
    if (fix.resolution === "notapplicable") {
        return translate("reviews.securityFix.working.review", { name });
    }
    return translate("reviews.securityFix.working.preparing", { name });
}

// Why a fix waits for a place, or needs the developer, in the interface language: MoltenTerm's own reason by its code, else
// the agent's own line.
function reasonText(t: TFunction, fix: SecurityFix): string {
    const detail = fix.outcome ?? "";
    if (fix.state === "waiting") {
        if (fix.reason === "machinebusy") {
            return t("reviews.securityFix.waiting.machineBusy");
        }
        if (fix.reason === "agentlimit") {
            return t("reviews.securityFix.waiting.agentLimit");
        }
        return t("reviews.securityFix.waiting.retry", { detail });
    }
    return t(`server.notif.secfix.why.${fix.reason || "outcome"}`, { detail, reason: detail });
}

function whenText(ms: number): string {
    return new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

// What a pull request that was blocked is doing now, one row of the fourth step.
function UnblockRow({ row, trunk, onGo }: { row: SecurityUnblockRow; trunk: string; onGo: (number: number) => void }) {
    const t = useT();
    const progress = t(`reviews.securityFix.after.progress.${row.progress}`, { trunk });
    const how = row.outcome?.how;
    const agent = row.outcome?.agent ?? "";
    const text =
        how === "handed"
            ? t("reviews.securityFix.after.handed", { agent: agent || t("reviews.securityFix.anAgent") })
            : how === "failed"
              ? t("reviews.securityFix.after.failed")
              : how === "updated"
                ? `${t("reviews.securityFix.after.updated", { trunk })} · ${progress}`
                : how === "rerun"
                  ? `${t("reviews.securityFix.after.rerun")} · ${progress}`
                  : progress;
    const mark: StateMarkKind =
        how === "handed"
            ? "running"
            : how === "failed"
              ? "blocked"
              : row.progress === "running"
                ? "running"
                : row.progress === "green"
                  ? "ready"
                  : row.progress === "red"
                    ? "blocked"
                    : "draft";
    return (
        <div className="flex items-center gap-2 text-12" data-testid="reviews-security-fix-after-row" data-pr={row.pr}>
            <StateMark kind={mark} label={t(`reviews.securityFix.after.mark.${mark}`)} />
            <button
                type="button"
                onClick={() => onGo(row.pr)}
                title={t("reviews.securityFix.goToCard", { number: row.pr })}
                className={cn("min-w-[44px] cursor-pointer text-left text-primary hover:underline", HitArea)}
            >
                #{row.pr}
            </button>
            <span className="min-w-0 text-secondary">{text}</span>
        </div>
    );
}

// The agent's own line, docked at the bottom edge of the block as the one under a card: who works, with which tool and on
// which branch, what it does and for how long, and the way to its terminal and to Stop.
function AgentBar({
    fix,
    pr,
    now,
    stoppable,
    stopping,
    onStop,
    onGo,
}: {
    fix: SecurityFix;
    pr: ReviewPr;
    now: number;
    stoppable: boolean;
    stopping: boolean;
    onStop: () => void;
    onGo: () => void;
}) {
    const t = useT();
    const pending = pr?.ci?.pending ?? 0;
    const total = pr?.ci?.checks?.length ?? 0;
    const status =
        fix.state === "needsyou"
            ? t("reviews.securityFix.bar.waits")
            : pending > 0 && total > 0
              ? t("reviews.securityFix.bar.ci", { done: Math.max(0, total - pending), total })
              : t("reviews.securityFix.bar.working");
    const tool = codingAgentName(fix.agent ?? "");
    return (
        <div
            className="-mx-3 -mb-2.5 flex min-w-0 flex-wrap items-center gap-x-1.5 border-t border-[color-mix(in_srgb,var(--mt-line-2)_50%,transparent)] bg-black/20 py-1 pr-2 pl-3.5 text-11 leading-5 text-muted"
            data-testid="reviews-security-fix-agent"
        >
            <Bot size={12} strokeWidth={2} aria-hidden className="shrink-0" />
            <span className="font-medium text-primary">{agentNameOf(fix)}</span>
            {tool || fix.branch ? (
                <span className="min-w-0 truncate">
                    {tool}
                    {tool && fix.branch ? " · " : ""}
                    {fix.branch ? <span className="font-mono">{fix.branch}</span> : null}
                </span>
            ) : null}
            <span className="inline-flex items-center gap-1 text-[var(--mt-state-running)]">
                {fix.state === "working" ? (
                    <span className="-mx-1 inline-flex scale-75" aria-hidden>
                        <DominoLoader />
                    </span>
                ) : null}
                {status}
            </span>
            {fix.startedat > 0 ? <span>· {durationText(t, Math.max(0, now - fix.startedat))}</span> : null}
            <span className="ml-auto flex items-center gap-1">
                {fix.blockid && fix.state === "working" ? (
                    <button
                        type="button"
                        onClick={onGo}
                        className={cn(
                            "inline-flex h-5 cursor-pointer items-center gap-1 rounded-4 px-1.5 text-11 text-secondary hover:bg-hover hover:text-primary",
                            HitArea
                        )}
                        data-testid="reviews-security-fix-go"
                    >
                        {t("reviews.securityFix.go")}
                        <ArrowRight size={12} strokeWidth={2} aria-hidden />
                    </button>
                ) : null}
                {stoppable && fix.state === "working" ? (
                    <button
                        type="button"
                        onClick={onStop}
                        aria-busy={stopping || undefined}
                        title={t("reviews.securityFix.stopTitle")}
                        className={cn(
                            "inline-flex h-5 cursor-pointer items-center gap-1 rounded-4 px-1.5 text-11 text-secondary hover:bg-hover hover:text-primary",
                            HitArea
                        )}
                        data-testid="reviews-security-fix-stop"
                    >
                        <CircleStop size={12} strokeWidth={2} aria-hidden />
                        {t("reviews.securityFix.stop")}
                    </button>
                ) : null}
            </span>
        </div>
    );
}

export function SecurityFixBlock({
    view,
    answer,
    dir,
    repo,
    trunk,
    now,
    onGoToCard,
    onValidate,
    onAssistedReview,
    onLater,
    onDismiss,
}: {
    view: SecurityFixBlockView;
    answer: ReviewsAnswer;
    dir: string;
    repo: string;
    trunk: string;
    // The minute clock, for how long the agent has worked.
    now: number;
    onGoToCard: (number: number) => void;
    // The merge goes through the Validate sheet every pull request has: nothing merges before the developer confirms there.
    onValidate: (pr: ReviewPr) => void;
    onAssistedReview: (pr: ReviewPr) => void;
    // Put the ask off, hide what a merge unblocked.
    onLater: () => void;
    onDismiss: () => void;
}) {
    const t = useT();
    const tc = useTCount();
    const word = useWordPhrase();
    useLocale();
    const [busy, setBusy] = useState<string>(null);
    const [problem, setProblem] = useState<Phrase>(null);
    const { step, fix, pr, block } = view;
    const filled = view.needsYou;
    // The first time, the ask is three buttons; once he answered it, MoltenTerm only offers the fix (FR-REV-036 AC10).
    const firstAsk = view.consent === "unasked";
    const stoppable = fix != null && isSecurityFixStoppable(fix);
    const run = (id: string, fn: () => Promise<Phrase>) => {
        if (busy != null) {
            return;
        }
        setBusy(id);
        setProblem(null);
        fireAndForget(async () => {
            try {
                setProblem(await fn());
            } finally {
                setBusy(null);
            }
        });
    };
    const launch = (id: string, answerKind?: "ask" | "always") =>
        run(id, () => launchSecurityFix({ dir, repo, trunk, fingerprint: view.key, answer: answerKind }));
    const stop = () => run("stop", () => stopSecurityFixOf(dir, fix.fingerprint));
    const goToTerminal = () => fireAndForget(() => showPanel(fix.blockid));
    const primary = (id: string, label: string, title: string | undefined, onClick: () => void) => (
        <button
            type="button"
            onClick={onClick}
            aria-busy={busy === id || undefined}
            title={title}
            className={cn(filled ? MoltenButton : CalmButton)}
            data-testid={`reviews-security-fix-${id}`}
            data-molten={filled || undefined}
        >
            {busy === id ? <DominoLoader /> : null}
            {label}
            {filled ? <MoltenWave /> : null}
        </button>
    );
    const ticket =
        fix?.ticket != null && fix.ticket > 0 ? (
            <span className="font-normal text-muted"> · {t("reviews.securityFix.ticket", { ticket: fix.ticket })}</span>
        ) : null;
    const name = agentNameOf(fix);
    const count = view.advisories.length;
    const prCount = view.prs.length;
    let title: string;
    let sub: string;
    switch (step) {
        case "ask": {
            title =
                prCount > 0
                    ? tc("reviews.securityFix.ask.title", prCount, { count: prCount })
                    : t("reviews.securityFix.ask.titleTrunk", { trunk });
            const check = block?.check ?? "";
            sub =
                block?.trunkfailing && prCount > 0
                    ? t("reviews.securityFix.ask.subTrunkPrs", { check, trunk, prs: prList(view.prs) })
                    : prCount > 0
                      ? t("reviews.securityFix.ask.subPrs", { check, prs: prList(view.prs) })
                      : t("reviews.securityFix.ask.subTrunk", { check, trunk });
            break;
        }
        case "working":
            title = t("reviews.securityFix.working.title");
            sub = `${blocksSentence(tc, view, trunk)} ${workingSentence(fix)}`;
            break;
        case "waiting":
            title = t("reviews.securityFix.waiting.title");
            sub = reasonText(t, fix);
            break;
        case "needsyou":
            title = fix.ticket
                ? t("reviews.securityFix.needsYou.title", { name, ticket: fix.ticket })
                : t("reviews.securityFix.needsYou.titleNoTicket");
            sub = reasonText(t, fix);
            break;
        case "ready":
            title =
                prCount > 0
                    ? t("reviews.securityFix.ready.title", { pr: fix.pr, prs: prList(view.prs) })
                    : t("reviews.securityFix.ready.titleAlone", { pr: fix.pr });
            sub = readySentence(t, tc, fix, pr, count);
            break;
        case "merged":
            title = fix.pr
                ? tc("reviews.securityFix.merged.title", prCount, { pr: fix.pr, count: prCount })
                : t("reviews.securityFix.merged.titleNoPr");
            sub = t("reviews.securityFix.merged.sub", { trunk: fix.trunk || trunk });
            break;
        case "stopped":
            title = t("reviews.securityFix.stopped.title");
            sub =
                prCount > 0
                    ? tc("reviews.securityFix.stopped.sub", count, { count, prs: prList(view.prs) })
                    : t("reviews.securityFix.stopped.subTrunk");
            break;
        case "failed":
            title = t("reviews.securityFix.failed.title");
            sub = fix.reason ? reasonText(t, fix) : (fix.outcome ?? "");
            break;
    }
    const showTable = step !== "merged";
    const review = fix?.resolution === "notapplicable" && (step === "ready" || step === "working");
    const unblockLine = (step === "working" || step === "waiting" || step === "needsyou") && prCount > 0;
    const agentBar = (step === "working" || step === "needsyou") && fix != null && (fix.agentname || fix.branch);
    return (
        <section
            role="group"
            aria-label={t("reviews.securityFix.aria")}
            tabIndex={-1}
            className={cn(
                "relative flex flex-col gap-2 overflow-hidden rounded-4 border border-[var(--mt-line-2)] bg-[var(--mt-surface-2)] px-3 py-2.5 outline-none",
                StepLines[step]
            )}
            data-testid="reviews-security-fix"
            data-step={step}
            data-security-fix={view.key}
            data-filled={filled || undefined}
        >
            <div className="flex items-start gap-2.5">
                <Tile step={step} />
                <div className="min-w-0 flex-1">
                    <div className="text-13 leading-5 font-semibold" data-testid="reviews-security-fix-title">
                        {title}
                        {step === "working" || step === "needsyou" || step === "waiting" ? ticket : null}
                    </div>
                    <div className="text-12 leading-[17px] text-secondary" data-testid="reviews-security-fix-sub">
                        {sub}
                    </div>
                </div>
                {fix?.auto && (step === "working" || step === "needsyou" || step === "waiting") ? (
                    <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-4 border border-[color-mix(in_srgb,var(--mt-state-running)_40%,transparent)] px-1.5 text-11 leading-4 text-[var(--mt-state-running)]"
                        title={t("reviews.securityFix.autoTitle")}
                        data-testid="reviews-security-fix-auto"
                    >
                        {t("reviews.securityFix.auto", { time: whenText(fix.startedat) })}
                    </span>
                ) : null}
                {step === "merged" ? (
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label={t("reviews.securityFix.merged.hide")}
                        title={t("reviews.securityFix.merged.hide")}
                        className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                        data-testid="reviews-security-fix-hide"
                    >
                        <X size={12} strokeWidth={2} aria-hidden />
                    </button>
                ) : null}
            </div>
            {showTable ? (
                <AdvisoryTable advisories={view.advisories} raised={step === "ready"} review={review} />
            ) : null}
            {unblockLine ? (
                <div
                    className="flex flex-wrap items-center gap-1.5 text-12"
                    data-testid="reviews-security-fix-unblocks"
                >
                    <span className="text-muted">{t("reviews.securityFix.unblocks")}</span>
                    <PrLinks numbers={view.prs} onGo={onGoToCard} />
                </div>
            ) : null}
            {step === "merged" ? (
                <div className="flex flex-col gap-1" data-testid="reviews-security-fix-after">
                    {securityUnblockRows(answer, fix).map((row) => (
                        <UnblockRow key={row.pr} row={row} trunk={fix.trunk || trunk} onGo={onGoToCard} />
                    ))}
                </div>
            ) : null}
            {agentBar ? (
                <AgentBar
                    fix={fix}
                    pr={pr}
                    now={now}
                    stoppable={stoppable}
                    stopping={busy === "stop"}
                    onStop={stop}
                    onGo={goToTerminal}
                />
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="reviews-security-fix-actions">
                {step === "ask" ? (
                    <>
                        {primary(
                            "launch",
                            t("reviews.securityFix.ask.launch"),
                            t("reviews.securityFix.ask.launchTitle"),
                            () => launch("launch", firstAsk ? "ask" : undefined)
                        )}
                        {firstAsk ? (
                            <button
                                type="button"
                                onClick={() => launch("always", "always")}
                                aria-busy={busy === "always" || undefined}
                                title={t("reviews.securityFix.ask.alwaysTitle")}
                                className={CalmButton}
                                data-testid="reviews-security-fix-always"
                            >
                                {busy === "always" ? <DominoLoader /> : null}
                                {t("reviews.securityFix.ask.always")}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={onLater}
                            className={GhostButton}
                            data-testid="reviews-security-fix-later"
                        >
                            {t("reviews.securityFix.ask.later")}
                        </button>
                    </>
                ) : null}
                {step === "ready" && fix != null ? (
                    <>
                        {pr != null
                            ? primary(
                                  "merge",
                                  t("reviews.securityFix.ready.merge", { pr: fix.pr }),
                                  t("reviews.securityFix.ready.mergeTitle", { pr: fix.pr }),
                                  () => onValidate(pr)
                              )
                            : null}
                        {pr != null ? (
                            <button
                                type="button"
                                onClick={() => onAssistedReview(pr)}
                                className={CalmButton}
                                data-testid="reviews-security-fix-review"
                            >
                                {t("reviews.securityFix.ready.assistedReview")}
                            </button>
                        ) : null}
                        {fix.prurl ? (
                            <button
                                type="button"
                                onClick={() => fireAndForget(() => openWebLink(fix.prurl))}
                                className={GhostButton}
                                data-testid="reviews-security-fix-github"
                            >
                                <ExternalLink size={12} strokeWidth={2} aria-hidden />
                                {t("reviews.securityFix.ready.github")}
                            </button>
                        ) : null}
                    </>
                ) : null}
                {step === "needsyou" && fix != null ? (
                    <>
                        {fix.blockid
                            ? primary("go", t("reviews.securityFix.needsYou.go"), undefined, goToTerminal)
                            : null}
                        {stoppable ? (
                            <button
                                type="button"
                                onClick={stop}
                                aria-busy={busy === "stop" || undefined}
                                title={t("reviews.securityFix.stopTitle")}
                                className={GhostButton}
                                data-testid="reviews-security-fix-stop"
                            >
                                <CircleStop size={12} strokeWidth={2} aria-hidden />
                                {t("reviews.securityFix.stop")}
                            </button>
                        ) : null}
                    </>
                ) : null}
                {step === "waiting" && stoppable ? (
                    <button
                        type="button"
                        onClick={stop}
                        aria-busy={busy === "stop" || undefined}
                        title={t("reviews.securityFix.stopTitle")}
                        className={GhostButton}
                        data-testid="reviews-security-fix-stop"
                    >
                        <CircleStop size={12} strokeWidth={2} aria-hidden />
                        {t("reviews.securityFix.stop")}
                    </button>
                ) : null}
                {step === "stopped" || step === "failed"
                    ? primary(
                          "relaunch",
                          t("reviews.securityFix.relaunch"),
                          t("reviews.securityFix.ask.launchTitle"),
                          () => launch("relaunch")
                      )
                    : null}
            </div>
            {step === "ask" ? (
                <div className="text-11 leading-4 text-muted" data-testid="reviews-security-fix-note">
                    {firstAsk ? t("reviews.securityFix.ask.note") : t("reviews.securityFix.ask.noteOffer")}
                </div>
            ) : null}
            {step === "ready" && prCount > 0 ? (
                <div className="text-11 leading-4 text-muted" data-testid="reviews-security-fix-note">
                    {t("reviews.securityFix.ready.note", { prs: prList(view.prs), trunk })}
                </div>
            ) : null}
            {problem != null ? (
                <div className="text-12 leading-4 text-danger" role="status" data-testid="reviews-security-fix-problem">
                    {word(problem)}
                </div>
            ) : null}
        </section>
    );
}

// What the ready fix's pull request holds, in a sentence: what it does to the advisories, then what is green on it.
function readySentence(
    t: TFunction,
    tc: (key: string, count: number, vars?: Record<string, string | number>) => string,
    fix: SecurityFix,
    pr: ReviewPr,
    count: number
): string {
    const does =
        fix.resolution === "notapplicable"
            ? t("reviews.securityFix.ready.reviewDone")
            : tc("reviews.securityFix.ready.bump", count, { count });
    const checks = pr?.ci?.checks ?? [];
    const facts: string[] = [];
    if (checks.length > 0 && (pr.ci.success ?? 0) === checks.length) {
        facts.push(t("reviews.securityFix.ready.ci", { success: pr.ci.success, total: checks.length }));
    }
    if (checks.some((check) => isLocalCheck(check) && check.state === "success")) {
        facts.push(t("reviews.securityFix.ready.localCi"));
    }
    if (pr?.report?.state === "present") {
        facts.push(t("reviews.securityFix.ready.report"));
    }
    return facts.length === 0 ? does : `${does} ${facts.join(", ")}.`;
}
