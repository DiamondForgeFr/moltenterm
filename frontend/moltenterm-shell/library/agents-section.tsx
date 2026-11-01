// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library's Agents section (FR-SHELL-088 #1699): what the first launch's agents scene offers, always at hand.
// Every agent of the catalog gets a card, and a page in one layout for all: status, profile, what works in MoltenTerm,
// links, Install and Uninstall. MoltenTerm offers every agent as a browser offers every search engine: no vendor
// first, the found ones then the others, each group by name.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentFacts, AgentUninstall, OnboardingAgent } from "../../moltenterm-onboarding/onboarding-agent-model";
import { installPhase, isRunning, type CliInstallStatus } from "../../moltenterm-onboarding/onboarding-install-model";
import { CopyLine, ExternalLink, withCodes } from "../../moltenterm-onboarding/onboarding-parts";
import type { PourAgentCard } from "../../moltenterm-onboarding/onboarding-pour-agents";
import { InstallOutput, SignInBody } from "../../moltenterm-onboarding/onboarding-pour-scenes";
import { AgentSignInModel } from "../../moltenterm-onboarding/onboarding-signin";
import { useT } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { SidebarGlyph } from "../sidebar/sidebar-icons";
import { DominoLoader } from "../suite/suite";
import { ChoosePath, LibraryChooseLook } from "./agents-choose";
import {
    agentStatusKind,
    BeyondCodeKinds,
    canRemoveConfig,
    configHoldsKey,
    hasProfile,
    installStatus,
    isStale,
    libraryAgents,
    manualUninstallCommands,
    matrixSummary,
    priceLine,
    priceText,
    uninstallOffer,
    uninstallPhase,
    uninstallRemoves,
    uninstallStatus,
    type LibraryAgent,
} from "./agents-model";
import { LibraryAgentsModel, type ChooseState } from "./agents-store";

function StatusChip({ card }: { card: PourAgentCard }) {
    const t = useT();
    const kind = agentStatusKind(card);
    return (
        <span className="mt-lib-agstate" data-state={kind} data-testid="library-agent-status">
            {t(`library.agents.status.${kind}`)}
        </span>
    );
}

export function AgentCard({ row, job }: { row: LibraryAgent; job: CliInstallStatus }) {
    const t = useT();
    const { card } = row;
    const running = isRunning(job);
    return (
        <button
            type="button"
            className="mt-lib-pcard mt-lib-agcard"
            data-testid="library-agent"
            data-agent={card.id}
            aria-label={t("library.agents.open", { name: card.name })}
            onClick={() => LibraryAgentsModel.getInstance().open(card.id)}
        >
            <div className="flex items-center gap-2 font-semibold text-primary">
                <i className="mt-lib-pic" aria-hidden>
                    <SidebarGlyph name="agents" size={16} />
                </i>
                <span className="truncate">{card.name}</span>
            </div>
            <code className="font-mono text-11 text-secondary">$ {card.command}</code>
            <p>
                {row.agent.profile?.goodforkey
                    ? t(row.agent.profile.goodforkey)
                    : t("onboarding.pour.agents.needs", {
                          account: t(`onboarding.pour.agents.account.${card.account}`, { provider: card.provider }),
                      })}
            </p>
            {row.agent.profile ? (
                <span className="text-11 text-secondary">{priceText(t, row.agent.profile)}</span>
            ) : null}
            <div className="flex items-center gap-2">
                {running ? (
                    <span className="mt-lib-agstate" data-state="running">
                        <DominoLoader />
                        {t(
                            job.kind === "uninstall"
                                ? "library.agents.uninstall.running"
                                : "library.agents.install.running",
                            {
                                name: card.name,
                            }
                        )}
                    </span>
                ) : (
                    <StatusChip card={card} />
                )}
            </div>
        </button>
    );
}

function AgentList({ rows, jobs }: { rows: LibraryAgent[]; jobs: Record<string, CliInstallStatus> }) {
    return (
        <div className="mt-lib-pcards" data-testid="library-agents">
            {rows.map((row) => (
                <AgentCard key={row.card.id} row={row} job={jobs[row.card.id]} />
            ))}
        </div>
    );
}

function Block({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
    return (
        <section className="mt-lib-agblock" data-testid={testId}>
            <h4>{title}</h4>
            {children}
        </section>
    );
}

function KeyList({ keys }: { keys: string[] }) {
    const t = useT();
    return (
        <ul className="mt-lib-aglist">
            {keys.map((k) => (
                <li key={k}>{t(k)}</li>
            ))}
        </ul>
    );
}

function PriceText({ profile }: { profile: AgentFacts }) {
    const t = useT();
    const line = priceLine(profile);
    if (line == null) {
        return null;
    }
    return (
        <div className="flex flex-col gap-0.5" data-testid="library-agent-price">
            <span className="text-primary">{priceText(t, profile)}</span>
            {line.noteKey ? <span className="text-secondary">{t(line.noteKey)}</span> : null}
            {line.freeUnknown ? (
                <span className="text-secondary">{t("library.agents.price.freeNotStated")}</span>
            ) : null}
            {profile.pricingpage ? (
                <ExternalLink href={profile.pricingpage}>{t("library.agents.profile.pricingPage")}</ExternalLink>
            ) : null}
        </div>
    );
}

function beyondKey(answer: string): string {
    if (answer === "yes" || answer === "no") {
        return `library.agents.beyond.${answer}`;
    }
    return "library.agents.beyond.notstated";
}

function ProfileBlock({ agent }: { agent: OnboardingAgent }) {
    const t = useT();
    const profile = agent.profile;
    if (!hasProfile(profile)) {
        return null;
    }
    const beyond = BeyondCodeKinds.filter((k) => profile.beyondcode?.[k]);
    return (
        <Block title={t("library.agents.sections.profile")} testId="library-agent-profile">
            <dl className="mt-lib-agfacts">
                {profile.models?.length ? (
                    <>
                        <dt>{t("library.agents.profile.models")}</dt>
                        <dd>
                            {profile.models.join(", ")}
                            {profile.modelspage ? (
                                <>
                                    {" "}
                                    <ExternalLink href={profile.modelspage}>
                                        {t("library.agents.profile.modelsPage")}
                                    </ExternalLink>
                                </>
                            ) : null}
                        </dd>
                    </>
                ) : null}
                {profile.goodforkey ? (
                    <>
                        <dt>{t("library.agents.profile.goodFor")}</dt>
                        <dd>{t(profile.goodforkey)}</dd>
                    </>
                ) : null}
                {profile.strengthkeys?.length ? (
                    <>
                        <dt>{t("library.agents.profile.strengths")}</dt>
                        <dd>
                            <KeyList keys={profile.strengthkeys} />
                        </dd>
                    </>
                ) : null}
                {profile.weakkeys?.length ? (
                    <>
                        <dt>{t("library.agents.profile.weak")}</dt>
                        <dd>
                            <KeyList keys={profile.weakkeys} />
                        </dd>
                    </>
                ) : null}
                <dt>{t("library.agents.profile.price")}</dt>
                <dd>
                    <PriceText profile={profile} />
                </dd>
                {profile.speedkey ? (
                    <>
                        <dt>{t("library.agents.profile.speed")}</dt>
                        <dd>{t(profile.speedkey)}</dd>
                    </>
                ) : null}
                {profile.limitskey ? (
                    <>
                        <dt>{t("library.agents.profile.limits")}</dt>
                        <dd>{t(profile.limitskey)}</dd>
                    </>
                ) : null}
                {beyond.length ? (
                    <>
                        <dt>{t("library.agents.profile.beyond")}</dt>
                        <dd>
                            {beyond
                                .map((k) =>
                                    t("library.agents.beyond.item", {
                                        kind: t(`library.agents.beyond.${k}`),
                                        answer: t(beyondKey(profile.beyondcode[k])),
                                    })
                                )
                                .join(" · ")}
                        </dd>
                    </>
                ) : null}
            </dl>
            {profile.notekey ? (
                <p className="mt-lib-agnote" data-testid="library-agent-note">
                    {t(profile.notekey)}{" "}
                    {profile.notepage ? (
                        <ExternalLink href={profile.notepage}>{t("library.agents.profile.notePage")}</ExternalLink>
                    ) : null}
                </p>
            ) : null}
            {profile.checkedon ? (
                <p className="text-11 text-secondary">
                    {t("library.agents.profile.checkedOn", { date: profile.checkedon })}
                    {isStale(profile.checkedon, new Date()) ? ` ${t("library.agents.profile.stale")}` : ""}
                </p>
            ) : null}
        </Block>
    );
}

// What works in MoltenTerm with the agent: the matrix's counts when wavesrv serves it (#1696), a marked slot for the
// detailed rows of #1685 meanwhile.
function WorksBlock({ card }: { card: PourAgentCard }) {
    const t = useT();
    const matrix = useAtomValue(LibraryAgentsModel.getInstance().matrixAtom);
    const summary = matrix != null && matrix !== "absent" ? matrixSummary(matrix, card.id) : null;
    let body: React.ReactNode;
    if (matrix == null) {
        body = <p>{t("library.agents.works.loading")}</p>;
    } else if (summary == null) {
        body = <p>{t("library.agents.works.pending", { name: card.name })}</p>;
    } else {
        body = (
            <>
                <p data-testid="library-agent-works-summary">
                    {t("library.agents.works.summary", {
                        name: card.name,
                        native: String(summary.native),
                        adapted: String(summary.adapted),
                        limited: String(summary.limited),
                        total: String(summary.total),
                    })}
                </p>
                {summary.asof ? (
                    <p className="text-11 text-secondary">{t("library.agents.works.asof", { date: summary.asof })}</p>
                ) : null}
            </>
        );
    }
    return (
        <Block title={t("library.agents.sections.works")} testId="library-agent-works">
            <div data-slot="what-works-1685">{body}</div>
        </Block>
    );
}

function LinksBlock({ card, agent }: { card: PourAgentCard; agent: OnboardingAgent }) {
    const t = useT();
    const links: [string, string][] = [
        [agent.site, "library.agents.links.site"],
        [card.plansPage, "library.agents.links.signIn"],
        [agent.docs, "library.agents.links.docs"],
        [card.installPage !== agent.docs ? card.installPage : null, "library.agents.links.installPage"],
    ];
    const shown = links.filter(([href]) => !!href);
    if (shown.length === 0) {
        return null;
    }
    return (
        <Block title={t("library.agents.sections.links")} testId="library-agent-links">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
                {shown.map(([href, key]) => (
                    <ExternalLink key={key} href={href}>
                        {t(key)}
                    </ExternalLink>
                ))}
            </div>
        </Block>
    );
}

function JobOutput({ card, job }: { card: PourAgentCard; job: CliInstallStatus }) {
    const model = LibraryAgentsModel.getInstance();
    return (
        <InstallOutput card={card} status={job} onAnswer={(text) => fireAndForget(() => model.answer(card.id, text))} />
    );
}

function jobFailure(
    t: (key: string, vars?: Record<string, string>) => string,
    job: CliInstallStatus,
    fallbackKey: string
) {
    if (job?.error) {
        return serverText(job.errortext, job.error);
    }
    if (job?.exitcode) {
        return t("library.agents.failedCode", { code: String(job.exitcode) });
    }
    return t(fallbackKey);
}

export function InstallBlock({ card, job }: { card: PourAgentCard; job: CliInstallStatus }) {
    const t = useT();
    const model = LibraryAgentsModel.getInstance();
    const phase = installPhase(job, card.ready);
    if (card.ready && phase === "ready") {
        return null;
    }
    const running = phase === "running";
    return (
        <Block title={t("library.agents.sections.install")} testId="library-agent-install">
            {card.install.length === 0 ? (
                <p>{t("library.agents.install.none", { name: card.name })}</p>
            ) : (
                <>
                    <p className="flex items-center gap-2">
                        {running ? <DominoLoader className="mt-lib-agdom" /> : null}
                        {t(running ? "library.agents.install.running" : "library.agents.install.text", {
                            name: card.name,
                        })}
                    </p>
                    <CopyLine text={card.install[0]} testId="library-agent-install-command" />
                    {phase === "failed" ? (
                        <p className="mt-lib-agwarn">{jobFailure(t, job, "library.agents.install.failed")}</p>
                    ) : null}
                    {phase === "notfound" ? (
                        <p className="mt-lib-agwarn">
                            {withCodes(t("library.agents.install.notFound"), { command: card.command })}
                        </p>
                    ) : null}
                    {phase === "canceled" ? <p>{t("library.agents.install.canceled")}</p> : null}
                    {job != null && (running || phase === "failed") ? <JobOutput card={card} job={job} /> : null}
                    <div className="flex flex-wrap items-center gap-2">
                        {running ? (
                            <button
                                type="button"
                                className="mt-lib-btn"
                                onClick={() => fireAndForget(() => model.cancel(card.id))}
                            >
                                {t("library.agents.cancel")}
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                                data-testid="library-agent-install-button"
                                onClick={() => fireAndForget(() => model.install(card.id))}
                            >
                                {t("library.agents.install.button", { name: card.name })}
                            </button>
                        )}
                    </div>
                </>
            )}
        </Block>
    );
}

function RemovesList({ paths, testId }: { paths: string[]; testId: string }) {
    return (
        <ul className="mt-lib-aglist font-mono text-11" data-testid={testId}>
            {paths.map((p) => (
                <li key={p}>{p}</li>
            ))}
        </ul>
    );
}

function ManualUninstall({ agent }: { agent: OnboardingAgent }) {
    const t = useT();
    const commands = manualUninstallCommands(agent);
    return (
        <div className="flex flex-col gap-2" data-testid="library-agent-uninstall-manual">
            <p>{t("library.agents.uninstall.manualText")}</p>
            {commands.length === 0 ? <p>{t("library.agents.uninstall.manualNone")}</p> : null}
            {commands.map((m) => (
                <div key={m.command} className="flex flex-col gap-1">
                    <span className="text-11 text-secondary">
                        {t(`library.agents.uninstall.method.${m.method}`)}
                        {m.documented ? "" : ` · ${t("library.agents.uninstall.undocumented")}`}
                    </span>
                    <CopyLine text={m.command} />
                </div>
            ))}
            <div className="flex flex-wrap gap-x-4">
                {commands[0]?.source ? (
                    <ExternalLink href={commands[0].source}>{t("library.agents.uninstall.source")}</ExternalLink>
                ) : null}
                {agent.docs ? <ExternalLink href={agent.docs}>{t("library.agents.links.docs")}</ExternalLink> : null}
            </div>
        </div>
    );
}

// What the uninstall did with the ticked settings folders: moved to the trash, or where it stopped.
export function TrashReport({ job }: { job: CliInstallStatus }) {
    const t = useT();
    if (!job?.trashed?.length && !job?.trashfailed) {
        return null;
    }
    return (
        <div className="flex flex-col gap-1" data-testid="library-agent-trash-report">
            {job.trashed?.length ? (
                <p>{t("library.agents.uninstall.trashed", { paths: job.trashed.join(", ") })}</p>
            ) : null}
            {job.trashfailed ? (
                <p className="mt-lib-agwarn">{serverText(job.trasherrortext, job.trashfailed)}</p>
            ) : null}
        </div>
    );
}

// The confirmation opens unticked every time (the block mounts it anew): moving the settings to the trash is asked
// each time, never remembered.
export function UninstallConfirm({
    card,
    uninstall,
    onCancel,
}: {
    card: PourAgentCard;
    uninstall: AgentUninstall;
    onCancel: () => void;
}) {
    const t = useT();
    const [removeConfig, setRemoveConfig] = useState(false);
    const model = LibraryAgentsModel.getInstance();
    const removes = uninstallRemoves(uninstall, removeConfig);
    return (
        <div className="mt-lib-ask" role="group" data-lib-escape="" data-testid="library-agent-uninstall-confirm">
            <b className="text-primary">{t("library.agents.uninstall.confirmTitle", { name: card.name })}</b>
            <span className="text-11 text-secondary">{t("library.agents.uninstall.confirmCommand")}</span>
            <CopyLine text={uninstall.command} testId="library-agent-uninstall-command" />
            {removes.files.length ? (
                <>
                    <span className="text-11 text-secondary">{t("library.agents.uninstall.confirmRemoves")}</span>
                    <RemovesList paths={removes.files} testId="library-agent-uninstall-removes" />
                </>
            ) : null}
            {removes.trash.length ? (
                <>
                    <span className="text-11 text-secondary">{t("library.agents.uninstall.confirmTrash")}</span>
                    <RemovesList paths={removes.trash} testId="library-agent-uninstall-trash" />
                </>
            ) : null}
            {canRemoveConfig(uninstall) ? (
                <label className="flex cursor-pointer items-start gap-2 text-12">
                    <input
                        type="checkbox"
                        className="mt-0.5 cursor-pointer"
                        checked={removeConfig}
                        data-testid="library-agent-uninstall-config"
                        onChange={(e) => setRemoveConfig(e.target.checked)}
                    />
                    <span>
                        {t("library.agents.uninstall.removeConfig", { name: card.name })}
                        <span className="block text-11 text-secondary" data-testid="library-agent-uninstall-holds">
                            {t("library.agents.uninstall.holdsIntro", { what: t(configHoldsKey(uninstall)) })}{" "}
                            {t(
                                removeConfig
                                    ? "library.agents.uninstall.removeConfigWarn"
                                    : "library.agents.uninstall.keeps"
                            )}
                        </span>
                    </span>
                </label>
            ) : (
                <span className="text-11 text-secondary">{t("library.agents.uninstall.keeps")}</span>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
                <button
                    type="button"
                    className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    data-testid="library-agent-uninstall-go"
                    onClick={() => {
                        onCancel();
                        fireAndForget(() => model.uninstall(card.id, removeConfig));
                    }}
                >
                    {t("library.agents.uninstall.confirm")}
                </button>
                <button
                    type="button"
                    className="mt-lib-link"
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            onCancel();
                        }
                    }}
                    onClick={onCancel}
                >
                    {t("common.cancel")}
                </button>
            </div>
        </div>
    );
}

export function UninstallBlock({
    card,
    agent,
    job,
}: {
    card: PourAgentCard;
    agent: OnboardingAgent;
    job: CliInstallStatus;
}) {
    const t = useT();
    const model = LibraryAgentsModel.getInstance();
    const [asking, setAsking] = useState(false);
    const offer = uninstallOffer(agent);
    const phase = uninstallPhase(job, card.ready);
    if (offer === "none" && (phase === "idle" || phase === "canceled")) {
        return null;
    }
    const running = phase === "running";
    let body: React.ReactNode;
    if (phase === "done") {
        body = (
            <p data-testid="library-agent-uninstall-done">{t("library.agents.uninstall.done", { name: card.name })}</p>
        );
    } else if (offer === "manual" && !running) {
        body = <ManualUninstall agent={agent} />;
    } else if (asking && !running) {
        body = <UninstallConfirm card={card} uninstall={agent.uninstall} onCancel={() => setAsking(false)} />;
    } else {
        body = (
            <>
                <p className="flex items-center gap-2">
                    {running ? <DominoLoader className="mt-lib-agdom" /> : null}
                    {t(running ? "library.agents.uninstall.running" : "library.agents.uninstall.text", {
                        name: card.name,
                        method: t(`library.agents.uninstall.method.${agent.uninstall?.method ?? "native"}`),
                    })}
                </p>
                {phase === "failed" ? (
                    <p className="mt-lib-agwarn">{jobFailure(t, job, "library.agents.uninstall.failed")}</p>
                ) : null}
                {phase === "stillfound" ? (
                    <p className="mt-lib-agwarn">
                        {withCodes(t("library.agents.uninstall.stillFound"), {
                            command: card.command,
                            path: agent.foundpath ?? "",
                        })}
                    </p>
                ) : null}
                {phase === "canceled" ? <p>{t("library.agents.uninstall.canceled")}</p> : null}
                {job != null && (running || phase === "failed") ? <JobOutput card={card} job={job} /> : null}
                <div className="flex flex-wrap items-center gap-2">
                    {running ? (
                        <button
                            type="button"
                            className="mt-lib-btn"
                            onClick={() => fireAndForget(() => model.cancel(card.id))}
                        >
                            {t("library.agents.cancel")}
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="mt-lib-btn"
                            data-testid="library-agent-uninstall-button"
                            onClick={() => setAsking(true)}
                        >
                            {t("library.agents.uninstall.button", { name: card.name })}
                        </button>
                    )}
                </div>
            </>
        );
    }
    return (
        <Block title={t("library.agents.sections.uninstall")} testId="library-agent-uninstall">
            {body}
            <TrashReport job={job} />
        </Block>
    );
}

export function StatusBlock({ card, agent }: { card: PourAgentCard; agent: OnboardingAgent }) {
    const t = useT();
    const model = LibraryAgentsModel.getInstance();
    const checking = useAtomValue(model.checkingAtom);
    const runs = useAtomValue(AgentSignInModel.getInstance().runsAtom);
    const account = t(`onboarding.pour.agents.account.${card.account}`, { provider: card.provider });
    return (
        <Block title={t("library.agents.sections.status")} testId="library-agent-state">
            <div className="flex flex-wrap items-center gap-2">
                <StatusChip card={card} />
                {card.ready && agent.foundpath ? (
                    <span className="text-11 text-secondary">
                        {withCodes(t("library.agents.foundAt"), { path: agent.foundpath })}
                    </span>
                ) : null}
            </div>
            <p>{t("onboarding.pour.agents.needs", { account })}</p>
            {card.ready && !card.signedIn ? <p>{t("library.agents.signInUnseen")}</p> : null}
            {card.ready && !card.signedIn && card.signIn ? (
                <SignInBody
                    card={card}
                    run={runs[card.id]}
                    checking={checking}
                    onSignIn={() => fireAndForget(() => model.signIn(card.id))}
                    onCheck={() => fireAndForget(() => model.load(true))}
                    buttonClass="mt-lib-btn"
                    testId="library-agent-signin"
                />
            ) : null}
        </Block>
    );
}

function AgentPage({ row, job }: { row: LibraryAgent; job: CliInstallStatus }) {
    const t = useT();
    const { card, agent } = row;
    const model = LibraryAgentsModel.getInstance();
    return (
        <div className="mt-lib-agpage" data-testid="library-agent-page" data-agent={card.id}>
            <button
                type="button"
                className="mt-lib-link self-start"
                data-testid="library-agent-back"
                onClick={() => model.open(null)}
            >
                <SidebarGlyph name="back" size={13} />
                {t("library.agents.back")}
            </button>
            <div className="flex items-center gap-3">
                <i className="mt-lib-pic" aria-hidden>
                    <SidebarGlyph name="agents" size={16} />
                </i>
                <div className="min-w-0">
                    <h4 className="text-15 font-semibold text-primary">{card.name}</h4>
                    <code className="font-mono text-11 text-secondary">$ {card.command}</code>
                </div>
            </div>
            <StatusBlock card={card} agent={agent} />
            <ProfileBlock agent={agent} />
            <WorksBlock card={card} />
            <LinksBlock card={card} agent={agent} />
            <InstallBlock card={card} job={installStatus(job)} />
            <UninstallBlock card={card} agent={agent} job={uninstallStatus(job)} />
        </div>
    );
}

function ChoosePanel({ rows, state }: { rows: LibraryAgent[]; state: ChooseState }) {
    const t = useT();
    const model = LibraryAgentsModel.getInstance();
    return (
        <section className="mt-lib-agblock" data-testid="library-choose" data-lib-escape="">
            <div className="flex items-center justify-between gap-2">
                <h4>{t("library.agents.choose.title")}</h4>
                <button
                    type="button"
                    className="mt-lib-link"
                    data-testid="library-choose-close"
                    onClick={() => model.closeChoose()}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            model.closeChoose();
                        }
                    }}
                >
                    {t("library.agents.choose.close")}
                </button>
            </div>
            <ChoosePath
                rows={rows}
                state={state}
                look={LibraryChooseLook}
                testId="library-choose"
                action={(row) => (
                    <button
                        type="button"
                        className="mt-lib-btn"
                        data-testid="library-choose-open"
                        onClick={() => model.open(row.card.id)}
                    >
                        {t("library.agents.choose.openPage")}
                    </button>
                )}
                onAnswer={(answers) => model.answerChoose(answers)}
                onBack={() => model.backChoose()}
                onRestart={() => model.startChoose()}
            />
            <p className="text-11 text-secondary">{t("library.agents.choose.private")}</p>
        </section>
    );
}

export function AgentsSection() {
    const t = useT();
    const model = LibraryAgentsModel.getInstance();
    const list = useAtomValue(model.listAtom);
    const error = useAtomValue(model.errorAtom);
    const checking = useAtomValue(model.checkingAtom);
    const openId = useAtomValue(model.openAtom);
    const jobs = useAtomValue(model.jobsAtom);
    const choose = useAtomValue(model.chooseAtom);
    useEffect(() => {
        fireAndForget(() => model.load());
        fireAndForget(() => model.loadMatrix());
    }, []);
    const rows = libraryAgents(list);
    useEffect(() => {
        for (const row of rows) {
            if (jobs[row.card.id] == null) {
                fireAndForget(() => model.refreshJob(row.card.id));
            }
        }
    }, [list == null]);
    const open = rows.find((r) => r.card.id === openId);
    return (
        <div className="flex flex-col gap-3" data-testid="library-agents-section">
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className="mt-lib-btn"
                    data-testid="library-agents-help"
                    title={t("library.agents.helpChooseTitle")}
                    aria-expanded={choose != null}
                    onClick={() => model.startChoose()}
                >
                    {t("library.agents.helpChoose")}
                </button>
                <button
                    type="button"
                    className={cn("mt-lib-link", checking && "opacity-60")}
                    data-testid="library-agents-check"
                    onClick={() => fireAndForget(() => model.load(true))}
                >
                    {t(checking ? "library.agents.checking" : "library.agents.checkAgain")}
                </button>
            </div>
            {error ? <p className="mt-lib-agwarn">{t("library.agents.listFailed", { error })}</p> : null}
            {list == null && !error ? <p className="mt-lib-empty">{t("library.agents.looking")}</p> : null}
            {choose != null && list != null ? <ChoosePanel rows={rows} state={choose} /> : null}
            {open != null ? <AgentPage row={open} job={jobs[open.card.id]} /> : <AgentList rows={rows} jobs={jobs} />}
        </div>
    );
}
