// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The SaaSFoundryAI and hand-off cards (FR-BOSS-010 AC16, #2251), under the project card in the free space of the
// brainstorm layer, once Brokk proposed them. Each shows exactly what its click does before the click: the setup its two
// profiles in MoltenTerm's own words, his choice and reason, and the command typed in a terminal of the project's
// workspace; the hand-off the agent, the workspace and the brief to edit. The click opens a shown terminal and takes the
// developer there; a click again goes to the terminal the first one opened. Until the project exists, a card waits.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { ReactNode, useEffect, useId } from "react";
import { useWorkspaceName } from "../agent-info/agent-info-hooks";
import { BossBubbleModel } from "../boss/boss-store";
import { tCount, useLocale, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { originTime } from "../reviews/agent-origin";
import { DominoLoader } from "../suite/suite";
import type { BrainstormState } from "./brainstorm-boot";
import {
    briefProblem,
    briefToSend,
    canHandoff,
    canSetup,
    DryRun,
    DryRunKey,
    dryRunView,
    fullInTwoSteps,
    installedAgents,
    Launch,
    launchCardOf,
    LaunchFailure,
    launchRefusalKey,
    LaunchStep,
    MaxHandoffBrief,
    Profiles,
    setupCommand,
    SetupPreview,
    SfInstallCommand,
    startingProfile,
} from "./brainstorm-launch-model";
import { BrainstormLaunchModel } from "./brainstorm-launch-store";
import "./brainstorm-launch.css";

function Eyebrow({ step, icon, text, folded }: { step: LaunchStep; icon: string; text: string; folded: boolean }) {
    const t = useT();
    const model = BrainstormLaunchModel.getInstance();
    return (
        <div className="mt-bsj-eyebrow">
            <i className={makeIconClass(icon, false)} aria-hidden />
            <span className="mt-bsj-eyebrow-text">{text}</span>
            <button
                type="button"
                className="mt-bsj-fold cursor-pointer"
                aria-expanded={!folded}
                aria-label={t(folded ? "boss.brainstorm.launch.unfold" : "boss.brainstorm.launch.fold")}
                title={t(folded ? "boss.brainstorm.launch.unfold" : "boss.brainstorm.launch.fold")}
                data-testid={`brainstorm-${step}-fold`}
                onClick={() => model.toggleFold(step)}
            >
                <i className={makeIconClass(folded ? "chevron-up" : "chevron-down", false)} aria-hidden />
            </button>
        </div>
    );
}

function Failure({
    step,
    failure,
    name,
    agent,
    onRetry,
}: {
    step: LaunchStep;
    failure: LaunchFailure;
    name: string;
    agent?: string;
    onRetry?: () => void;
}) {
    const t = useT();
    if (failure == null) {
        return null;
    }
    return (
        <div className="mt-bsj-failure" role="alert" data-testid={`brainstorm-${step}-failure`} data-refusal={failure}>
            <span>{t(launchRefusalKey(failure), { name, agent: agent ?? "" })}</span>
            {onRetry != null ? (
                <button
                    type="button"
                    className="mt-bsj-link cursor-pointer"
                    data-testid={`brainstorm-${step}-retry`}
                    onClick={onRetry}
                >
                    {t("boss.brainstorm.launch.tryAgain")}
                </button>
            ) : null}
        </div>
    );
}

function Working({ step, text }: { step: LaunchStep; text: string }) {
    return (
        <div className="mt-bsj-working" data-testid={`brainstorm-${step}-working`}>
            <DominoLoader />
            <span>{text}</span>
        </div>
    );
}

// What a click opened, and the way to it: the setup's or the update's terminal, or the agent's.
function Launched({ id, launch, text }: { id: "setup" | "update" | "handoff"; launch: Launch; text: string }) {
    const t = useT();
    const model = BrainstormLaunchModel.getInstance();
    return (
        <>
            <div className="mt-bsj-done" data-testid={`brainstorm-${id}-launched`}>
                <i className={makeIconClass("check", false)} aria-hidden />
                <span>{text}</span>
            </div>
            {!launch.typed && launch.command ? (
                <>
                    <p className="mt-bsj-note">{t("boss.brainstorm.launch.notTyped")}</p>
                    <code className="mt-bsj-path mt-bsl-command" data-testid={`brainstorm-${id}-untyped`}>
                        {launch.command}
                    </code>
                </>
            ) : null}
            <div className="mt-bsj-acts">
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    title={t("boss.brainstorm.launch.goTitle")}
                    data-testid={`brainstorm-${id}-goto`}
                    onClick={() => void model.goTo(launch)}
                >
                    {t(id === "handoff" ? "boss.brainstorm.handoff.goTo" : "boss.brainstorm.setup.goTo")}
                    <MoltenWave />
                </button>
            </div>
        </>
    );
}

function Command({ step, command }: { step: LaunchStep; command: string }) {
    const t = useT();
    return (
        <div className="mt-bsj-line">
            <span className="mt-bsj-key">{t("boss.brainstorm.setup.command")}</span>
            <code className="mt-bsj-path mt-bsl-command" title={command} data-testid={`brainstorm-${step}-command`}>
                {command}
            </code>
        </div>
    );
}

// The two profiles, each in MoltenTerm's own plain words; his recommendation is marked, the selected one carries the
// action liseré.
function ProfileTiles({ preview, profile, name }: { preview: SetupPreview; profile: string; name: string }) {
    const t = useT();
    const model = BrainstormLaunchModel.getInstance();
    const recommended = startingProfile(preview);
    return (
        <div className="mt-bsl-tiles" role="radiogroup" aria-label={t("boss.brainstorm.setup.choose")}>
            {Profiles.map((p) => {
                const on = p === profile;
                return (
                    <button
                        key={p}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        className={cn("mt-bsl-tile cursor-pointer", on && "is-on mt-selected-action")}
                        data-testid={`brainstorm-setup-profile-${p}`}
                        onClick={() => model.chooseProfile(p)}
                    >
                        <span className="mt-bsl-tile-head">
                            <span className="mt-bsl-tile-title">{t(`boss.brainstorm.setup.profiles.${p}.title`)}</span>
                            {p === recommended ? (
                                <span className="mt-bsl-chip" data-testid="brainstorm-setup-recommended">
                                    {t("boss.brainstorm.setup.recommended", { name })}
                                </span>
                            ) : null}
                        </span>
                        <span className="mt-bsl-tile-sub">{t(`boss.brainstorm.setup.profiles.${p}.subtitle`)}</span>
                        <span className="mt-bsl-tile-lines">
                            {["line1", "line2", "line3"].map((line) => (
                                <span key={line}>{t(`boss.brainstorm.setup.profiles.${p}.${line}`)}</span>
                            ))}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

function NoSf() {
    const t = useT();
    const model = BrainstormLaunchModel.getInstance();
    const copied = useAtomValue(model.copiedAtom, { store: globalStore });
    return (
        <div className="mt-bsl-nosf" data-testid="brainstorm-setup-nosf">
            <p className="mt-bsj-note">{t("boss.brainstorm.setup.nosf")}</p>
            <div className="mt-bsj-path-row">
                <code className="mt-bsj-path mt-bsl-command" data-testid="brainstorm-setup-install">
                    {SfInstallCommand}
                </code>
                <button
                    type="button"
                    className="mt-bsj-link cursor-pointer"
                    data-testid="brainstorm-setup-copy"
                    onClick={() => void model.copyInstall(SfInstallCommand)}
                >
                    {t(copied ? "boss.brainstorm.setup.copied" : "boss.brainstorm.setup.copy")}
                </button>
            </div>
            <p className="mt-bsj-note">{t("boss.brainstorm.setup.nosfNote")}</p>
            <div className="mt-bsj-acts">
                <button
                    type="button"
                    className="mt-bsj-btn cursor-pointer"
                    data-testid="brainstorm-setup-check"
                    onClick={() => void model.refreshSetup(true)}
                >
                    <i className={makeIconClass("rotate", false)} aria-hidden />
                    {t("boss.brainstorm.setup.checkAgain")}
                </button>
            </div>
        </div>
    );
}

function DryRunSummary({ dryRun }: { dryRun: DryRun }) {
    const t = useT();
    const view = dryRunView(dryRun);
    if (view === "full") {
        return (
            <p className="mt-bsj-note" data-testid="brainstorm-setup-dryrun" data-view={view}>
                {t("boss.brainstorm.setup.dryFull")}
            </p>
        );
    }
    if (view === "blocked") {
        return (
            <p className="mt-bsj-note" data-testid="brainstorm-setup-dryrun" data-view={view}>
                {t("boss.brainstorm.setup.dryBlocked")}
            </p>
        );
    }
    return (
        <ul className="mt-bsj-facts" data-testid="brainstorm-setup-dryrun" data-view={view}>
            <li>
                {dryRun.add > 0
                    ? tCount("boss.brainstorm.setup.dryAdds", dryRun.add)
                    : t("boss.brainstorm.setup.dryHarness")}
            </li>
            {dryRun.conflict > 0 ? <li>{tCount("boss.brainstorm.setup.dryConflicts", dryRun.conflict)}</li> : null}
        </ul>
    );
}

// A folder set up already (by the setup's first step, or by hand): the dry run on the developer's Preview, whose exact
// command the card names, then the update when it can run. While the setup's terminal is still there, the card asks
// to let it finish first.
function Managed({ preview, workspace }: { preview: SetupPreview; workspace: string }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormLaunchModel.getInstance();
    const dryRun = useAtomValue(model.dryRunAtom, { store: globalStore });
    const dryBusy = useAtomValue(model.dryRunBusyAtom, { store: globalStore });
    const busy = useAtomValue(model.setupBusyAtom, { store: globalStore });
    const command = setupCommand(preview);
    if (preview.update != null) {
        return (
            <Launched
                id="update"
                launch={preview.update}
                text={t("boss.brainstorm.setup.updateLaunched", { time: originTime(preview.update.at, locale) })}
            />
        );
    }
    return (
        <>
            <p className="mt-bsj-note" data-testid="brainstorm-setup-managed">
                {t("boss.brainstorm.setup.managed")}
            </p>
            {preview.launched != null ? (
                <p className="mt-bsj-note" data-testid="brainstorm-setup-running">
                    {t("boss.brainstorm.setup.setupRunning")}
                </p>
            ) : null}
            {dryBusy ? (
                <Working step="setup" text={t("boss.brainstorm.setup.dryRunning")} />
            ) : dryRun == null ? (
                <div className="mt-bsj-acts">
                    <button
                        type="button"
                        className="mt-bsj-btn cursor-pointer"
                        data-testid="brainstorm-setup-dryrun-start"
                        onClick={() => void model.dryRun()}
                    >
                        <i className={makeIconClass("eye", false)} aria-hidden />
                        {t("boss.brainstorm.setup.previewFull")}
                    </button>
                    <span className="mt-bsj-key" data-testid="brainstorm-setup-dryrun-note">
                        {t("boss.brainstorm.setup.previewFullNote", { command: preview.commands?.[DryRunKey] ?? "" })}
                    </span>
                </div>
            ) : (
                <DryRunSummary dryRun={dryRun} />
            )}
            {dryRunView(dryRun) === "adds" && command !== "" ? (
                <>
                    <Command step="setup" command={command} />
                    <p className="mt-bsj-note">
                        {workspace
                            ? t("boss.brainstorm.setup.questions", { workspace })
                            : t("boss.brainstorm.setup.questionsThere")}
                    </p>
                    {busy ? (
                        <Working step="setup" text={t("boss.brainstorm.launch.opening")} />
                    ) : (
                        <button
                            type="button"
                            className="molten-btn mt-bsj-create cursor-pointer rounded-4 px-3 py-1.5 text-12"
                            title={t("boss.brainstorm.setup.startTitle")}
                            disabled={!canSetup(preview, "", busy, dryRun)}
                            data-testid="brainstorm-setup-start"
                            onClick={() => void model.startSetup(t("boss.brainstorm.setup.tabName"))}
                        >
                            {t("boss.brainstorm.setup.startUpdate")}
                            <MoltenWave />
                        </button>
                    )}
                </>
            ) : null}
        </>
    );
}

function SetupReady({ name }: { name: string }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormLaunchModel.getInstance();
    const preview = useAtomValue(model.setupPreviewAtom, { store: globalStore });
    const picked = useAtomValue(model.profileAtom, { store: globalStore });
    const busy = useAtomValue(model.setupBusyAtom, { store: globalStore });
    const failure = useAtomValue(model.setupFailureAtom, { store: globalStore });
    const workspace = useWorkspaceName(preview?.workspace ?? "");
    if (preview == null) {
        return <DominoLoader label={t("boss.brainstorm.launch.previewing")} />;
    }
    const retry = () => void model.refreshSetup();
    const profile = picked || startingProfile(preview);
    const twoSteps = fullInTwoSteps(preview, profile);
    const setupLaunched =
        preview.launched != null ? (
            <Launched
                id="setup"
                launch={preview.launched}
                text={t("boss.brainstorm.setup.launched", { time: originTime(preview.launched.at, locale) })}
            />
        ) : null;
    if (preview.managed && preview.refusal !== "nosf") {
        return (
            <>
                {setupLaunched}
                <Managed preview={preview} workspace={workspace} />
                <Failure step="setup" failure={failure} name={name} onRetry={retry} />
            </>
        );
    }
    if (setupLaunched != null) {
        return (
            <>
                {setupLaunched}
                {twoSteps ? (
                    <p className="mt-bsj-note" data-testid="brainstorm-setup-step2">
                        {t("boss.brainstorm.setup.step2Waiting")}
                    </p>
                ) : null}
            </>
        );
    }
    if (preview.refusal === "nosf") {
        return <NoSf />;
    }
    if (preview.refusal) {
        return <Failure step="setup" failure={preview.refusal as LaunchFailure} name={name} onRetry={retry} />;
    }
    const command = setupCommand(preview);
    return (
        <>
            <ProfileTiles preview={preview} profile={profile} name={name} />
            {preview.profilereason ? (
                <p className="mt-bsj-note mt-bsl-reason" data-testid="brainstorm-setup-reason">
                    {t("boss.brainstorm.setup.reason", { name, reason: preview.profilereason })}
                </p>
            ) : null}
            {command !== "" ? <Command step="setup" command={command} /> : null}
            {twoSteps ? (
                <p className="mt-bsj-note" data-testid="brainstorm-setup-two-steps">
                    {t("boss.brainstorm.setup.fullSteps")}
                </p>
            ) : null}
            <p className="mt-bsj-note">
                {workspace
                    ? t("boss.brainstorm.setup.questions", { workspace })
                    : t("boss.brainstorm.setup.questionsThere")}
            </p>
            <Failure step="setup" failure={failure} name={name} onRetry={retry} />
            {busy ? (
                <Working step="setup" text={t("boss.brainstorm.launch.opening")} />
            ) : (
                <button
                    type="button"
                    className="molten-btn mt-bsj-create cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    title={t("boss.brainstorm.setup.startTitle")}
                    disabled={!canSetup(preview, profile, busy)}
                    data-testid="brainstorm-setup-start"
                    onClick={() => void model.startSetup(t("boss.brainstorm.setup.tabName"))}
                >
                    {profile === "full"
                        ? t("boss.brainstorm.setup.startFull")
                        : profile === "harness"
                          ? t("boss.brainstorm.setup.startHarness")
                          : t("boss.brainstorm.setup.chooseFirst")}
                    <MoltenWave />
                </button>
            )}
        </>
    );
}

function HandoffReady({ name }: { name: string }) {
    const t = useT();
    const locale = useLocale();
    const agentId = useId();
    const briefId = useId();
    const model = BrainstormLaunchModel.getInstance();
    const preview = useAtomValue(model.handoffPreviewAtom, { store: globalStore });
    const edited = useAtomValue(model.briefAtom, { store: globalStore });
    const busy = useAtomValue(model.handoffBusyAtom, { store: globalStore });
    const failure = useAtomValue(model.handoffFailureAtom, { store: globalStore });
    const workspace = useWorkspaceName(preview?.workspace ?? "");
    if (preview == null) {
        return <DominoLoader label={t("boss.brainstorm.launch.previewing")} />;
    }
    const retry = () => void model.refreshHandoff();
    if (preview.launched != null) {
        return (
            <Launched
                id="handoff"
                launch={preview.launched}
                text={t("boss.brainstorm.handoff.launched", {
                    agent: preview.launched.agentname || preview.launched.agent || "",
                    time: originTime(preview.launched.at, locale),
                })}
            />
        );
    }
    if (preview.refusal === "noproject" || preview.refusal === "nobrief" || preview.refusal === "noagent") {
        return <Failure step="handoff" failure={preview.refusal as LaunchFailure} name={name} onRetry={retry} />;
    }
    const agents = installedAgents(preview);
    const brief = briefToSend(edited, preview);
    const problem = briefProblem(brief);
    const agentName = preview.agentname || "";
    return (
        <>
            <div className="mt-bsj-line">
                <label className="mt-bsj-key" htmlFor={agentId}>
                    {t("boss.brainstorm.handoff.agent")}
                </label>
                <select
                    id={agentId}
                    className="mt-bsj-select cursor-pointer"
                    value={preview.agent ?? ""}
                    disabled={busy || agents.length === 0}
                    data-testid="brainstorm-handoff-agent"
                    onChange={(e) => model.chooseAgent(e.target.value)}
                >
                    {preview.agent ? null : <option value="">{t("boss.brainstorm.handoff.pickAgent")}</option>}
                    {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                            {a.name}
                        </option>
                    ))}
                </select>
            </div>
            <div className="mt-bsj-line">
                <span className="mt-bsj-key">{t("boss.brainstorm.handoff.workspace")}</span>
                <span className="mt-bsl-value" data-testid="brainstorm-handoff-workspace">
                    {workspace || t("boss.brainstorm.handoff.thisWorkspace")}
                </span>
            </div>
            <div className="mt-bsl-brief">
                <div className="mt-bsl-brief-head">
                    <label className="mt-bsj-key" htmlFor={briefId}>
                        {t("boss.brainstorm.handoff.brief")}
                    </label>
                    {edited != null ? (
                        <button
                            type="button"
                            className="mt-bsj-link cursor-pointer"
                            data-testid="brainstorm-handoff-reset"
                            onClick={() => model.resetBrief()}
                        >
                            {t("boss.brainstorm.handoff.reset", { name })}
                        </button>
                    ) : null}
                </div>
                <textarea
                    id={briefId}
                    className="mt-bsj-input mt-bsl-textarea"
                    value={brief}
                    rows={9}
                    maxLength={MaxHandoffBrief}
                    disabled={busy}
                    spellCheck={false}
                    data-testid="brainstorm-handoff-brief"
                    onChange={(e) => model.editBrief(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                />
                {problem !== "" ? (
                    <p
                        className="mt-bsl-problem"
                        role="status"
                        data-testid="brainstorm-handoff-problem"
                        data-problem={problem}
                    >
                        {problem === "empty"
                            ? t("boss.brainstorm.handoff.empty")
                            : t("boss.brainstorm.handoff.tooLong", { count: brief.length, max: MaxHandoffBrief })}
                    </p>
                ) : (
                    <p className="mt-bsj-key">{t("boss.brainstorm.handoff.briefNote")}</p>
                )}
            </div>
            {agentName ? (
                <p className="mt-bsj-note">
                    {workspace
                        ? t("boss.brainstorm.handoff.note", { agent: agentName, workspace })
                        : t("boss.brainstorm.handoff.noteThere", { agent: agentName })}
                </p>
            ) : null}
            <Failure
                step="handoff"
                failure={failure ?? ((preview.refusal || null) as LaunchFailure)}
                name={name}
                agent={preview.chosenname}
                onRetry={retry}
            />
            {busy ? (
                <Working step="handoff" text={t("boss.brainstorm.handoff.starting", { agent: agentName })} />
            ) : (
                <button
                    type="button"
                    className="molten-btn mt-bsj-create cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    title={t("boss.brainstorm.handoff.startTitle")}
                    disabled={!canHandoff(preview, brief, busy)}
                    data-testid="brainstorm-handoff-start"
                    onClick={() => void model.startHandoff(t("boss.brainstorm.handoff.tabName"))}
                >
                    {agentName
                        ? t("boss.brainstorm.handoff.start", { agent: agentName })
                        : t("boss.brainstorm.handoff.pickAgent")}
                    <MoltenWave />
                </button>
            )}
        </>
    );
}

function LaunchCard({
    step,
    state,
    icon,
    eyebrow,
    label,
    children,
}: {
    step: LaunchStep;
    state: BrainstormState;
    icon: string;
    eyebrow: string;
    label: string;
    children: (name: string) => ReactNode;
}) {
    const t = useT();
    const model = BrainstormLaunchModel.getInstance();
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const folded = useAtomValue(step === "setup" ? model.setupFoldedAtom : model.handoffFoldedAtom, {
        store: globalStore,
    });
    const card = launchCardOf(state, step);
    const ready = card.kind === "ready";
    const brainstormId = state?.brainstorm?.id ?? "";
    const workspace = state?.brainstorm?.promotedto?.workspace ?? "";
    useEffect(() => {
        if (ready) {
            void model.show(step);
        }
    }, [ready, brainstormId, workspace]);
    if (card.kind === "none") {
        return null;
    }
    return (
        <section
            className={cn("mt-bsj mt-bsl", folded && "is-folded")}
            aria-label={label}
            data-testid={`brainstorm-${step}`}
            data-kind={card.kind}
        >
            <Eyebrow step={step} icon={icon} text={eyebrow} folded={folded} />
            {folded ? null : (
                <div className="mt-bsj-body">
                    {card.kind === "waiting" ? (
                        <p className="mt-bsj-note" data-testid={`brainstorm-${step}-waiting`}>
                            {t(`boss.brainstorm.${step}.waiting`, { name })}
                        </p>
                    ) : (
                        children(name)
                    )}
                </div>
            )}
        </section>
    );
}

export function SetupCard({ state }: { state: BrainstormState }) {
    const t = useT();
    return (
        <LaunchCard
            step="setup"
            state={state}
            icon="gears"
            eyebrow={t("boss.brainstorm.setup.eyebrow")}
            label={t("boss.brainstorm.setup.label")}
        >
            {(name) => <SetupReady name={name} />}
        </LaunchCard>
    );
}

export function HandoffCard({ state }: { state: BrainstormState }) {
    const t = useT();
    return (
        <LaunchCard
            step="handoff"
            state={state}
            icon="person-walking-arrow-right"
            eyebrow={t("boss.brainstorm.handoff.eyebrow")}
            label={t("boss.brainstorm.handoff.label")}
        >
            {(name) => <HandoffReady name={name} />}
        </LaunchCard>
    );
}
