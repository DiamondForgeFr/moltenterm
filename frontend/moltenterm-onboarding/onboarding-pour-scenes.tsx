// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The welcome and agents scenes of the pour (FR-ONB-007): each takes what it shows as props, so the scenes render
// without a window in tests. The scenes that set the workshop up are in onboarding-pour-build.tsx (#1709);
// onboarding-pour.tsx holds the stage, the navigation and the sparks.

import { modalsModel } from "@/app/store/modalmodel";
import { MoltentermRepoUrl } from "@/util/moltenterm-identity";
import { useEffect, useId, useRef, useState } from "react";
import { AgentWorks } from "../moltenterm-shell/agent-info/agent-works";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { serverText } from "../moltenterm-shell/i18n/server-text";
import { ChoosePath, type ChooseLook } from "../moltenterm-shell/library/agents-choose";
import {
    answerChooseState,
    backChooseState,
    ChooseQuestionCount,
    hasProfile,
    isStale,
    libraryAgents,
    priceText,
    startChooseState,
    suggestedIds,
    type ChooseState,
} from "../moltenterm-shell/library/agents-model";
import { GlowRing } from "../moltenterm-shell/suite/suite";
import {
    cleanInstallOutput,
    CliInstallStatus,
    installPhase,
    isRunning,
    isSecretQuestion,
} from "./onboarding-install-model";
import type { AgentFacts, OnboardingAgents } from "./onboarding-agent-model";
import { CopyLine, ExternalLink, withCodes } from "./onboarding-parts";
import { CodexHooksCommand, needsSignIn, PourAgentCard } from "./onboarding-pour-agents";

export const MoltentermLicenseUrl = `${MoltentermRepoUrl}/blob/main/LICENSE`;
export const MoltentermPrivacyUrl = `${MoltentermRepoUrl}/blob/main/PRIVACY.md`;

const PourChooseLook: ChooseLook = {
    answer: "mt-pour-act",
    link: "mt-pour-link",
    cards: "mt-pour-choose-cards",
    card: "mt-pour-choose-card",
    list: "mt-pour-choose-list",
    glyph: "mt-pour-choose-glyph",
};

// The mark's path padded so its stroke and glow are not clipped (the identity's own viewBox is 0 0 298 235).
const MarkViewBox = "-6 -6 310 247";
// The molten surface: a wavy top, poured up from below the mould by .mt-pour-melt.
const MeltPath = "M-10 6 Q40 -6 90 6 T190 6 T310 6 V260 H-10 Z";

function Title({ a, b }: { a: string; b: string }) {
    return (
        <h1>
            {a}
            <br />
            <span className="mt-pour-hot">{b}</span>
        </h1>
    );
}

// The real MoltenTerm mark (one fused path, moltenterm-identity.ts) in its mould: it fills like molten metal, then
// sets; the small mould of the last scene shows it set.
export function PourMark({ markPath, small }: { markPath: string; small?: boolean }) {
    const id = useId().replace(/[^\w-]/g, "");
    const gradient = `mt-pour-g-${id}`;
    const clip = `mt-pour-c-${id}`;
    return (
        <div className="mt-pour-mould" data-small={small ? "" : undefined} aria-hidden>
            {small ? null : <span className="mt-pour-drop" />}
            <GlowRing on />
            <svg viewBox={MarkViewBox}>
                <defs>
                    <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="235">
                        <stop offset="0" stopColor="var(--pour-white)" />
                        <stop offset=".3" stopColor="var(--pour-hot)" />
                        <stop offset="1" stopColor="var(--pour-molten)" />
                    </linearGradient>
                    <clipPath id={clip}>
                        <path d={markPath} />
                    </clipPath>
                </defs>
                {small ? null : <path className="mt-pour-cavity" d={markPath} />}
                <g className="mt-pour-glow">
                    {small ? null : (
                        <g clipPath={`url(#${clip})`}>
                            <g className="mt-pour-melt">
                                <path d={MeltPath} fill={`url(#${gradient})`} />
                            </g>
                        </g>
                    )}
                    <path className="mt-pour-set" d={markPath} />
                </g>
            </svg>
        </div>
    );
}

// Scene 1, the pour (AC-3): the mark fills, then the title and what MoltenTerm is; the licence and the privacy
// commitment stay one click away (NFR-ONB-002).
export function PourScene({ markPath, names }: { markPath: string; names: [string, string] }) {
    const t = useT();
    return (
        <div className="mt-pour-inner">
            <PourMark markPath={markPath} />
            <div className="mt-pour-kicker mt-pour-rise" data-d="1">
                {t("onboarding.pour.pour.kicker")}
            </div>
            <div className="mt-pour-rise" data-d="2">
                <Title a={t("onboarding.pour.pour.titleA")} b={t("onboarding.pour.pour.titleB")} />
            </div>
            <p className="mt-pour-sub mt-pour-rise" data-d="3">
                {t("onboarding.pour.pour.sub", { first: names[0], second: names[1] })}
            </p>
            <p className="mt-pour-sub mt-pour-rise" data-d="3" data-testid="pour-steps">
                {t("onboarding.pour.pour.steps")}
            </p>
            <p className="mt-pour-legal mt-pour-rise flex flex-wrap justify-center gap-x-3 gap-y-1" data-d="3">
                <span>{t("onboarding.pour.legal.license")}</span>
                <a href={MoltentermLicenseUrl} target="_blank" rel="noopener" className="cursor-pointer">
                    {t("onboarding.pour.legal.licence")}
                </a>
                <a href={MoltentermPrivacyUrl} target="_blank" rel="noopener" className="cursor-pointer">
                    {t("onboarding.pour.legal.privacy")}
                </a>
                <button
                    type="button"
                    onClick={() => modalsModel.pushModal("AboutModal")}
                    className="cursor-pointer"
                    data-testid="first-run-about"
                >
                    {t("onboarding.pour.legal.about")}
                </button>
            </p>
        </div>
    );
}

// The short profile of FR-ONB-008 (#1697): what the agent is good for, its cost line as the vendor's page shows it, and
// the date the facts were checked. The full profile is the agent's Library page.
function CardProfile({ profile }: { profile: AgentFacts }) {
    const t = useT();
    if (!hasProfile(profile)) {
        return null;
    }
    const price = priceText(t, profile);
    return (
        <div className="flex flex-col gap-0.5 text-11" data-testid="pour-card-profile">
            {profile.goodforkey ? <span className="text-primary">{t(profile.goodforkey)}</span> : null}
            {price ? <span className="text-secondary">{price}</span> : null}
            {profile.checkedon ? (
                <span className="text-muted" data-testid="pour-card-checked">
                    {t(
                        isStale(profile.checkedon, new Date())
                            ? "onboarding.pour.agents.profile.checkedStale"
                            : "onboarding.pour.agents.profile.checked",
                        { date: profile.checkedon }
                    )}
                </span>
            ) : null}
        </div>
    );
}

function AgentCardView({
    card,
    profile,
    suggested,
    heating,
    installing,
    open,
    onToggle,
    onInstall,
}: {
    card: PourAgentCard;
    profile?: AgentFacts;
    suggested?: boolean;
    heating: boolean;
    installing: boolean;
    open: boolean;
    onToggle: () => void;
    onInstall: () => void;
}) {
    const t = useT();
    const status = card.recipe
        ? t("onboarding.pour.agents.status.recipe", { agent: card.agentName })
        : installing
          ? t("onboarding.pour.agents.status.installing")
          : heating
            ? t("onboarding.pour.agents.status.looking")
            : card.ready && card.signedIn
              ? t("onboarding.pour.agents.status.signedIn")
              : card.ready
                ? t("onboarding.pour.agents.status.ready")
                : t("onboarding.pour.agents.status.missing");
    // Install runs the command; while it runs, the button only opens or closes its details. A found agent whose sign-in
    // MoltenTerm did not see opens its sign-in step (#1680).
    const signIn = needsSignIn(card);
    const act = card.recipe || signIn || installing || card.install.length === 0 ? onToggle : onInstall;
    return (
        <div
            className="mt-pour-agent"
            data-agent={card.id}
            data-ready={card.ready ? "" : undefined}
            data-heating={heating || installing ? "" : undefined}
            data-installing={installing ? "" : undefined}
            data-open={open ? "" : undefined}
            data-suggested={suggested ? "" : undefined}
        >
            <div className="mt-pour-ingot" />
            {suggested ? (
                <span className="mt-pour-match" data-testid={`pour-match-${card.id}`}>
                    {t("onboarding.pour.agents.choose.match")}
                </span>
            ) : null}
            <div className="text-15 font-semibold">{card.name}</div>
            <div className="-mt-1.5 font-mono text-11 text-secondary">
                {card.recipe
                    ? t("onboarding.pour.agents.recipeCommand", { command: card.command })
                    : `$ ${card.command}`}
            </div>
            <div className="flex flex-col gap-0.5 text-11 text-secondary">
                <span>{t(`onboarding.pour.agents.account.${card.account}`, { provider: card.provider })}</span>
                {card.recipe ? null : <AgentWorks agent={card.id} className="mt-0.5" />}
                {card.hooksNote && card.ready ? (
                    <span className="text-muted" data-testid="pour-codex-hooks">
                        {withCodes(t("onboarding.pour.agents.hooks"), { command: CodexHooksCommand })}
                    </span>
                ) : null}
            </div>
            <CardProfile profile={profile} />
            <div className="mt-auto flex items-center justify-between gap-2">
                <div className="mt-pour-status flex items-center gap-1.5 text-12 text-muted">
                    {installing ? (
                        <i className="fa-solid fa-spinner fa-spin text-[var(--pour-hot)]" aria-hidden />
                    ) : (
                        <span className="mt-pour-status-dot" />
                    )}
                    {status}
                </div>
                {card.ready && !card.recipe && !signIn ? null : (
                    <button
                        type="button"
                        className="mt-pour-act cursor-pointer"
                        aria-expanded={open}
                        onClick={act}
                        data-testid={`pour-act-${card.id}`}
                    >
                        {t(
                            card.recipe
                                ? "onboarding.pour.agents.configure"
                                : signIn
                                  ? "onboarding.pour.agents.signIn"
                                  : installing
                                    ? open
                                        ? "onboarding.pour.agents.hideDetails"
                                        : "onboarding.pour.agents.showDetails"
                                    : "onboarding.pour.agents.install"
                        )}
                    </button>
                )}
            </div>
        </div>
    );
}

// The installer's live output, and a field to answer it when it waits for a question (a password, a confirmation).
// The Library's agent pages show it too, for their install and uninstall (#1699).
export function InstallOutput({
    card,
    status,
    onAnswer,
}: {
    card: PourAgentCard;
    status: CliInstallStatus;
    onAnswer: (text: string) => void;
}) {
    const t = useT();
    const [answer, setAnswer] = useState("");
    const pre = useRef<HTMLPreElement>(null);
    const output = cleanInstallOutput(status?.output);
    const waiting = !!status?.waiting && isRunning(status);
    useEffect(() => {
        const el = pre.current;
        if (el != null) {
            el.scrollTop = el.scrollHeight;
        }
    }, [output]);
    const send = (e: React.FormEvent) => {
        e.preventDefault();
        onAnswer(answer);
        setAnswer("");
    };
    return (
        <div className="flex flex-col gap-1.5">
            <pre
                ref={pre}
                className="max-h-44 overflow-auto rounded-4 border border-border bg-black/30 px-2.5 py-2 font-mono text-11 leading-4 whitespace-pre-wrap text-secondary"
                data-testid={`pour-output-${card.id}`}
                aria-live="polite"
            >
                {output || t("onboarding.pour.agents.noOutput")}
            </pre>
            {waiting ? (
                <form className="flex flex-col gap-1.5" onSubmit={send} data-testid={`pour-answer-${card.id}`}>
                    <label className="text-12 text-secondary" htmlFor={`pour-answer-input-${card.id}`}>
                        {t("onboarding.pour.agents.asking")}
                    </label>
                    <div className="flex items-center gap-2">
                        <input
                            id={`pour-answer-input-${card.id}`}
                            type={isSecretQuestion(status.output) ? "password" : "text"}
                            value={answer}
                            autoFocus
                            autoComplete="off"
                            onChange={(e) => setAnswer(e.target.value)}
                            className="min-w-0 flex-1 rounded-4 border border-border bg-transparent px-2 py-1 font-mono text-12 text-primary"
                        />
                        <button
                            type="submit"
                            className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1 text-12"
                        >
                            {t("onboarding.pour.agents.send")}
                        </button>
                    </div>
                </form>
            ) : null}
        </div>
    );
}

// What Install or Configure opens. Install runs the catalog's command (AC-5, #1667): the loader, the command, Show
// details for the live output, Cancel; then Ready, or what went wrong with the output and the command to copy. The
// recipe cards show their recipe.
function AgentDrawer({
    card,
    claudeReady,
    checking,
    install,
    onCheck,
    onInstall,
    onAnswer,
    onCancel,
}: {
    card: PourAgentCard;
    claudeReady: boolean;
    checking: boolean;
    install: CliInstallStatus;
    onCheck: () => void;
    onInstall: () => void;
    onAnswer: (text: string) => void;
    onCancel: () => void;
}) {
    const t = useT();
    const [details, setDetails] = useState(false);
    const drawer = useRef<HTMLDivElement>(null);
    const account = t(`onboarding.pour.agents.account.${card.account}`, { provider: card.provider });
    const phase = card.recipe ? "idle" : installPhase(install, card.ready);
    const running = phase === "running";
    const failed = phase === "failed" || phase === "notfound";
    // An installer asking a question opens its output, so it never waits unseen.
    const showOutput = failed || (running && (details || !!install?.waiting));
    let title: string;
    let text: string;
    if (card.recipe) {
        title = t("onboarding.pour.agents.recipeTitle", { model: card.name, agent: card.agentName });
        text = t("onboarding.pour.agents.recipeText", { model: card.name });
    } else if (running) {
        title = t("onboarding.pour.agents.installing", { name: card.name });
        text = t("onboarding.pour.agents.installingText");
    } else if (phase === "failed") {
        title = t("onboarding.pour.agents.failedTitle", { name: card.name });
        text = install?.error
            ? serverText(install.errortext, install.error)
            : install?.exitcode
              ? t("onboarding.pour.agents.failedCode", { code: String(install.exitcode) })
              : t("onboarding.pour.agents.failedText");
    } else if (phase === "notfound") {
        title = t("onboarding.pour.agents.failedTitle", { name: card.name });
        text = t("onboarding.pour.agents.notFound", { command: card.command });
    } else if (phase === "canceled") {
        title = t("onboarding.pour.agents.installTitle", { name: card.name });
        text = t("onboarding.pour.agents.canceled");
    } else {
        title = t("onboarding.pour.agents.installTitle", { name: card.name });
        text = t("onboarding.pour.agents.installText");
    }
    const commands = card.recipe ? [(card.recipeLines ?? []).join("\n")] : card.install;
    // What changes in the drawer (the output opening, a failure) is scrolled into view, above the navigation.
    useEffect(() => {
        drawer.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }, [phase, showOutput]);
    return (
        <div
            ref={drawer}
            className="mt-pour-drawer"
            data-testid={`pour-drawer-${card.id}`}
            data-phase={phase}
            role={failed ? "alert" : undefined}
        >
            <div className="flex items-center gap-2 text-13 font-semibold">
                {running ? <i className="fa-solid fa-spinner fa-spin text-[var(--pour-hot)]" aria-hidden /> : null}
                {title}
            </div>
            <p className="text-12 leading-5 text-secondary" data-testid={`pour-drawer-text-${card.id}`}>
                {text}
            </p>
            {failed ? <p className="text-12 text-secondary">{t("onboarding.pour.agents.fallback")}</p> : null}
            <div className="flex flex-col gap-1.5">
                {commands.slice(0, 1).map((line) => (
                    <CopyLine key={line} text={line} testId={`pour-command-${card.id}`} />
                ))}
                {running
                    ? null
                    : commands.slice(1).map((line) => (
                          <div key={line} className="flex flex-col gap-1">
                              <span className="text-11 text-muted">{t("onboarding.pour.agents.or")}</span>
                              <CopyLine text={line} />
                          </div>
                      ))}
            </div>
            {showOutput ? <InstallOutput card={card} status={install} onAnswer={onAnswer} /> : null}
            {running ? null : (
                <p className="text-12 text-secondary">{t("onboarding.pour.agents.needs", { account })}</p>
            )}
            {card.recipe && !claudeReady ? (
                <p className="text-12 text-secondary">
                    {t("onboarding.pour.agents.recipeNeedsAgent", { agent: card.agentName })}
                </p>
            ) : null}
            {card.hooksNote && !running ? (
                <p className="text-12 text-secondary">
                    {withCodes(t("onboarding.pour.agents.hooks"), { command: CodexHooksCommand })}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
                {running ? (
                    <>
                        <button
                            type="button"
                            onClick={() => setDetails(!details)}
                            aria-expanded={showOutput}
                            className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                            data-testid={`pour-details-${card.id}`}
                        >
                            {t(
                                showOutput ? "onboarding.pour.agents.hideDetails" : "onboarding.pour.agents.showDetails"
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={onCancel}
                            className="cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:text-primary"
                            data-testid={`pour-cancel-${card.id}`}
                        >
                            {t("onboarding.pour.agents.cancel")}
                        </button>
                    </>
                ) : null}
                {!running && !card.recipe && card.install.length > 0 && phase !== "idle" ? (
                    <button
                        type="button"
                        onClick={onInstall}
                        className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                        data-testid={`pour-retry-${card.id}`}
                    >
                        {t("onboarding.pour.agents.tryAgain")}
                    </button>
                ) : null}
                {card.recipe || running ? null : (
                    <button
                        type="button"
                        disabled={checking}
                        onClick={onCheck}
                        className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                        data-testid="pour-check-again"
                    >
                        {checking ? t("onboarding.pour.agents.status.looking") : t("onboarding.pour.agents.checkAgain")}
                    </button>
                )}
                {card.installPage && !running ? (
                    <ExternalLink href={card.installPage}>
                        {t(card.recipe ? "onboarding.pour.agents.recipePage" : "onboarding.pour.agents.installPage")}
                    </ExternalLink>
                ) : null}
                {card.signInPage && !running ? (
                    <ExternalLink href={card.signInPage}>{t("onboarding.pour.agents.signInPage")}</ExternalLink>
                ) : null}
            </div>
        </div>
    );
}

// The step after the install (#1680): the agent is on this computer, it now needs an account with its vendor. MoltenTerm
// never starts the agent to find out: it only looks for the credentials file the vendor documents, and where there is
// none to look for, says the sign-in comes at the first start.
function SignInStep({ card, checking, onCheck }: { card: PourAgentCard; checking: boolean; onCheck: () => void }) {
    const t = useT();
    const drawer = useRef<HTMLDivElement>(null);
    const account = t(`onboarding.pour.agents.account.${card.account}`, { provider: card.provider });
    useEffect(() => {
        drawer.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }, []);
    return (
        <div ref={drawer} className="mt-pour-drawer" data-testid={`pour-signin-${card.id}`}>
            <div className="text-13 font-semibold">{t("onboarding.pour.agents.signInTitle", { name: card.name })}</div>
            <p className="text-12 leading-5 text-secondary">
                {t("onboarding.pour.agents.signInText", { name: card.name, account })}
            </p>
            <p className="text-12 leading-5 text-secondary">
                {withCodes(t("onboarding.pour.agents.signInFirstStart"), { command: card.command })}
            </p>
            <div className="flex flex-wrap items-center gap-3">
                {card.signInPage ? (
                    <ExternalLink href={card.signInPage}>{t("onboarding.pour.agents.signInPage")}</ExternalLink>
                ) : null}
                <button
                    type="button"
                    disabled={checking}
                    onClick={onCheck}
                    className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    data-testid="pour-signin-check"
                >
                    {checking ? t("onboarding.pour.agents.status.looking") : t("onboarding.pour.agents.checkAgain")}
                </button>
            </div>
        </div>
    );
}

// Scene 2, your agents heat up (AC-4, AC-5): the real detection, as cards.
export function AgentsScene({
    cards,
    list,
    initialChoose,
    loading,
    error,
    checking,
    open,
    ready,
    installs,
    onToggle,
    onCheck,
    onInstall,
    onAnswer,
    onCancel,
}: {
    cards: PourAgentCard[];
    // wavesrv's listing, for the profiles and Help me choose (#1697)
    list?: OnboardingAgents;
    // where Help me choose starts (tests): a step below 3 opens the path, 3 shows the cards with the suggestions
    initialChoose?: ChooseState;
    loading: boolean;
    error?: string;
    checking: boolean;
    open: string;
    // the agent that became ready at the last check, for "{name} is ready"
    ready?: string;
    installs?: Record<string, CliInstallStatus>;
    onToggle: (id: string) => void;
    onCheck: () => void;
    onInstall?: (id: string) => void;
    onAnswer?: (id: string, text: string) => void;
    onCancel?: (id: string) => void;
}) {
    const t = useT();
    // Help me choose (FR-ONB-008 AC-6 to AC-9): offered, never opened by itself; the answers stay in this scene.
    const [choose, setChoose] = useState<ChooseState>(initialChoose ?? null);
    const [pathOpen, setPathOpen] = useState(initialChoose != null && initialChoose.step < ChooseQuestionCount);
    const rows = libraryAgents(list);
    const profiles = new Map(rows.map((r) => [r.card.id, r.agent.profile]));
    const suggested = pathOpen ? [] : suggestedIds(rows, choose);
    const found = cards.filter((c) => c.ready).length;
    const openCard = cards.find((c) => c.id === open);
    const startPath = () => {
        setChoose(startChooseState());
        setPathOpen(true);
    };
    const closePath = () => {
        setPathOpen(false);
        if (choose != null && choose.step < ChooseQuestionCount) {
            setChoose(null);
        }
    };
    const cardView = (card: PourAgentCard) => (
        <AgentCardView
            key={card.id}
            card={card}
            profile={profiles.get(card.id)}
            suggested={suggested.includes(card.id)}
            heating={checking && !card.ready && !card.recipe}
            installing={!card.ready && isRunning(installs?.[card.id])}
            open={card.id === open}
            onToggle={() => onToggle(card.id)}
            onInstall={() => onInstall?.(card.id)}
        />
    );
    const claudeReady = cards.some((c) => c.id === "claude-code" && c.ready);
    let sub: string;
    if (error) {
        sub = error;
    } else if (loading) {
        sub = t("onboarding.pour.agents.looking");
    } else if (ready) {
        sub = t("onboarding.pour.agents.nowReady", { name: ready });
    } else {
        sub =
            found === 0
                ? t("onboarding.pour.agents.found.none")
                : found === 1
                  ? t("onboarding.pour.agents.found.one")
                  : t("onboarding.pour.agents.found.other", { count: found });
    }
    return (
        <div className="mt-pour-inner" data-testid="pour-agents">
            <div className="mt-pour-kicker">{t("onboarding.pour.agents.kicker")}</div>
            <Title a={t("onboarding.pour.agents.titleA")} b={t("onboarding.pour.agents.titleB")} />
            <p className="mt-pour-sub" role="status">
                {sub}
            </p>
            {rows.length > 0 && !pathOpen ? (
                <div className="mt-pour-choose-entry" data-testid="pour-choose-entry">
                    {suggested.length > 0 ? (
                        <span className="text-12 text-secondary" data-testid="pour-choose-highlighted">
                            {t("onboarding.pour.agents.choose.highlighted")}
                        </span>
                    ) : (
                        <span className="text-12 text-secondary">{t("onboarding.pour.agents.choose.lead")}</span>
                    )}
                    <button
                        type="button"
                        className="mt-pour-act cursor-pointer"
                        data-testid="pour-choose-open"
                        title={t("library.agents.helpChooseTitle")}
                        onClick={startPath}
                    >
                        {t(suggested.length > 0 ? "onboarding.pour.agents.choose.again" : "library.agents.helpChoose")}
                    </button>
                    {suggested.length > 0 ? (
                        <button
                            type="button"
                            className="mt-pour-link cursor-pointer"
                            data-testid="pour-choose-clear"
                            onClick={() => setChoose(null)}
                        >
                            {t("onboarding.pour.agents.choose.clear")}
                        </button>
                    ) : null}
                </div>
            ) : null}
            {pathOpen && choose != null ? (
                <section className="mt-pour-drawer mt-pour-choose" data-testid="pour-choose">
                    <div className="flex items-center justify-between gap-2">
                        <b className="text-14">{t("library.agents.choose.title")}</b>
                        <button
                            type="button"
                            className="mt-pour-link cursor-pointer"
                            data-testid="pour-choose-close"
                            onClick={closePath}
                        >
                            {t("onboarding.pour.agents.choose.toCards")}
                        </button>
                    </div>
                    <ChoosePath
                        rows={rows}
                        state={choose}
                        look={PourChooseLook}
                        testId="pour-choose"
                        endActions={
                            <button
                                type="button"
                                className="mt-pour-act cursor-pointer"
                                data-testid="pour-choose-cards"
                                onClick={closePath}
                            >
                                {t("onboarding.pour.agents.choose.toCards")}
                            </button>
                        }
                        onAnswer={(answers) => setChoose(answerChooseState(choose, answers))}
                        onBack={() => setChoose(backChooseState(choose))}
                        onRestart={() => setChoose(startChooseState())}
                    />
                    <p className="text-11 text-secondary">{t("library.agents.choose.private")}</p>
                </section>
            ) : (
                <div className="mt-pour-forge">{cards.map(cardView)}</div>
            )}
            {!pathOpen && openCard && needsSignIn(openCard) ? (
                <SignInStep key={openCard.id} card={openCard} checking={checking} onCheck={onCheck} />
            ) : null}
            {!pathOpen && openCard && !(openCard.ready && !openCard.recipe) ? (
                <AgentDrawer
                    key={openCard.id}
                    card={openCard}
                    claudeReady={claudeReady}
                    checking={checking}
                    install={installs?.[openCard.id]}
                    onCheck={onCheck}
                    onInstall={() => onInstall?.(openCard.id)}
                    onAnswer={(text) => onAnswer?.(openCard.id, text)}
                    onCancel={() => onCancel?.(openCard.id)}
                />
            ) : null}
        </div>
    );
}
