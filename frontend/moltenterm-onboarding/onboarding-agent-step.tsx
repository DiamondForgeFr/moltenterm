// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 1, "Your agent" (FR-ONB-002, DS-ONB-002). MoltenTerm ships no model: the user's own coding agent reshapes it.
// The step shows the catalog's agents, which ones this machine has, the molten guides MoltenTerm installed for them at
// start (FR-ONB-006) and how to call /morph in each, then keeps the one the user works with for step 2. It writes
// nothing, except the guides of an agent the user declined and wants back. What MoltenTerm adds when an agent starts
// in its terminals is in Settings > Agents (#322), linked rather than repeated.

import { cn, fireAndForget } from "@/util/util";
import { useCallback, useEffect, useState } from "react";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { openSettingsSection } from "../moltenterm-shell/settings/settings-open";
import {
    canMorph,
    catalogAgents,
    ChosenAgentKey,
    foundAgents,
    genericAgent,
    genericRequest,
    guideCall,
    guideState,
    OnboardingAgent,
    OnboardingAgents,
    OnboardingGuide,
    preselectedAgent,
} from "./onboarding-agent-model";
import { installDeclinedAgent, listOnboardingAgents } from "./onboarding-client";
import { Code, CopyLine, ExternalLink, StepText } from "./onboarding-parts";
import type { FirstRunStepContext } from "./onboarding-steps";

function GuideLine({ guide, version }: { guide: OnboardingGuide; version: string }) {
    const state = guideState(guide, version);
    return (
        <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-12">
            <Code>{guideCall(guide.invocation)}</Code>
            {state === "installed" ? <span className="text-muted">v{guide.version}</span> : null}
            {state === "outdated" ? (
                <span className="text-muted">v{guide.version}, updated at the next start</span>
            ) : null}
            {state === "missing" ? <span className="text-muted">not installed yet</span> : null}
            {state === "foreign" ? (
                <span className="text-warning" title={guide.path}>
                    a file MoltenTerm did not write is at its place; it is left alone
                </span>
            ) : null}
        </li>
    );
}

function AgentRow({
    agent,
    version,
    selected,
    busy,
    onSelect,
    onReinstall,
}: {
    agent: OnboardingAgent;
    version: string;
    selected: boolean;
    busy: boolean;
    onSelect: () => void;
    onReinstall: () => void;
}) {
    if (!agent.found) {
        return (
            <li className="flex items-center gap-3 px-3 py-2" data-agent={agent.id} data-found="false">
                <i className="fa-solid fa-minus w-[13px] text-center text-muted" aria-hidden />
                <span className="flex-1 text-13 text-secondary">{agent.name}</span>
                <span className="text-12 text-muted">Not found</span>
                {agent.installpage ? <ExternalLink href={agent.installpage}>Install</ExternalLink> : null}
            </li>
        );
    }
    return (
        <li
            className={cn("flex flex-col gap-2 px-3 py-2.5", selected && "bg-hover")}
            data-agent={agent.id}
            data-found="true"
        >
            <label className="flex cursor-pointer items-center gap-3">
                <input
                    type="radio"
                    name="first-run-agent"
                    checked={selected}
                    onChange={onSelect}
                    className="cursor-pointer accent-accent"
                />
                <span className="flex-1 text-13 font-medium text-primary">{agent.name}</span>
                {agent.declined ? (
                    <span className="text-12 text-muted">Declined</span>
                ) : (
                    <span className="flex items-center gap-1.5 text-12 text-secondary">
                        <i className="fa-solid fa-circle-check text-[var(--mt-state-done)]" aria-hidden />
                        Found
                    </span>
                )}
            </label>
            {agent.declined ? (
                <div className="flex flex-wrap items-center gap-2 pl-7 text-12 text-muted">
                    <span>
                        Its molten guides were removed with <Code>molten agent remove {agent.id}</Code>.
                    </span>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onReinstall}
                        className="molten-btn-secondary cursor-pointer rounded-6 px-2 py-1 text-12"
                    >
                        Install its guides again
                    </button>
                </div>
            ) : (
                <ul className="flex flex-col gap-1 pl-7">
                    {(agent.guides ?? []).map((guide) => (
                        <GuideLine key={guide.name} guide={guide} version={version} />
                    ))}
                </ul>
            )}
        </li>
    );
}

function GenericOption({ agent }: { agent: OnboardingAgent }) {
    if (agent == null) {
        return null;
    }
    return (
        <div className="flex flex-col gap-2 rounded-4 border border-border px-3 py-2.5" data-agent={agent.id}>
            <span className="text-13 font-medium text-primary">Another coding agent</span>
            <StepText>
                Any agent can follow MoltenTerm&apos;s instruction file
                {agent.installed ? (
                    <>
                        {" "}
                        at <Code>{agent.path}</Code>
                    </>
                ) : (
                    <>
                        : <Code>molten agent install generic</Code> writes it to <Code>{agent.path}</Code>
                    </>
                )}
                . Point your agent to it with:
            </StepText>
            <CopyLine text={genericRequest(agent, "<what you want MoltenTerm to do>")} />
        </div>
    );
}

function NoAgentFound({ agents, busy, onRetry }: { agents: OnboardingAgent[]; busy: boolean; onRetry: () => void }) {
    return (
        <div className="flex flex-col gap-3" data-testid="first-run-no-agent">
            <StepText>
                MoltenTerm ships no AI and needs no API key: the coding agent you already use reshapes it. None of the
                agents MoltenTerm supports is on this machine&apos;s PATH. Install one, then look again, or skip this
                step: Getting started offers it again.
            </StepText>
            <ul className="flex flex-col gap-1.5">
                {agents.map((agent) => (
                    <li key={agent.id} className="text-13">
                        {agent.installpage ? (
                            <ExternalLink href={agent.installpage}>{agent.name}</ExternalLink>
                        ) : (
                            agent.name
                        )}
                    </li>
                ))}
            </ul>
            <div>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onRetry}
                    className="molten-btn-secondary cursor-pointer rounded-6 px-3 py-1.5 text-12"
                >
                    Look again
                </button>
            </div>
        </div>
    );
}

function IntegrationNote() {
    return (
        <StepText className="text-12 text-muted">
            When Claude Code or Codex starts in a MoltenTerm terminal, MoltenTerm integrates that run (precise states,
            usage gauges, the browser) without touching your own settings or credentials.{" "}
            <button
                type="button"
                onClick={() => fireAndForget(() => openSettingsSection("agents"))}
                className="cursor-pointer text-accent hover:underline"
            >
                Agent settings
            </button>
        </StepText>
    );
}

export function AgentStep({ ctx }: { ctx: FirstRunStepContext }) {
    const [list, setList] = useState<OnboardingAgents>(null);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [picked, setPicked] = useState<string>(null);

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            setList(await listOnboardingAgents());
        } catch (e) {
            setError(`The agents could not be listed: ${e?.message ?? e}`);
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        fireAndForget(load);
    }, [load]);

    const reinstall = async (id: string) => {
        setBusy(true);
        setError(null);
        try {
            await installDeclinedAgent(id);
        } catch (e) {
            setError(`${e?.message ?? e}`);
        } finally {
            setBusy(false);
        }
        await load();
    };

    if (list == null) {
        return error ? (
            <p className="text-13 text-error" role="alert">
                {error}
            </p>
        ) : (
            <StepText>Looking for the coding agents on this machine…</StepText>
        );
    }

    const catalog = catalogAgents(list);
    const found = foundAgents(list);
    const selected = picked ?? preselectedAgent(list, ctx.data?.[ChosenAgentKey]);
    const chosen = found.find((a) => a.id === selected);

    if (found.length === 0) {
        return (
            <div className="flex flex-col gap-4">
                <NoAgentFound agents={catalog} busy={busy} onRetry={() => fireAndForget(load)} />
                <GenericOption agent={genericAgent(list)} />
                {error ? <p className="text-12 text-error">{error}</p> : null}
            </div>
        );
    }

    const keepChosen = () =>
        ctx.setData({ [ChosenAgentKey]: chosen.id }).then(
            () => ctx.complete(),
            (e) => setError(`${e?.message ?? e}`)
        );

    return (
        <div className="flex flex-col gap-4" data-testid="first-run-agents">
            <StepText>
                MoltenTerm ships no AI: your own coding agent reshapes it. MoltenTerm installed its guides for the
                agents it found, so <Code>/morph</Code> and the change you want, in your agent, turns into a mod. Pick
                the agent you work with.
            </StepText>
            <ul className="flex flex-col divide-y divide-border rounded-4 border border-border">
                {catalog.map((agent) => (
                    <AgentRow
                        key={agent.id}
                        agent={agent}
                        version={list.version}
                        selected={agent.id === selected}
                        busy={busy}
                        onSelect={() => setPicked(agent.id)}
                        onReinstall={() => fireAndForget(() => reinstall(agent.id))}
                    />
                ))}
            </ul>
            <GenericOption agent={genericAgent(list)} />
            <IntegrationNote />
            {error ? (
                <p className="text-12 text-error" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    disabled={busy || chosen == null}
                    onClick={() => fireAndForget(keepChosen)}
                    className="molten-btn cursor-pointer rounded-6 px-4 py-1.5 text-12 font-medium"
                    data-testid="first-run-use-agent"
                >
                    {chosen == null ? "Pick an agent" : `Use ${chosen.name}`}
                    <MoltenWave />
                </button>
                {chosen != null && !canMorph(chosen) ? (
                    <span className="text-12 text-muted">
                        Its /morph guide is not installed: step 2 shows what to do.
                    </span>
                ) : null}
            </div>
        </div>
    );
}
