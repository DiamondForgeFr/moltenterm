// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Project header's Release menu (FR-MC-015), as Notulia's ReleaseLauncher: the next release candidate and the next
// public release with their numbers, computed when the menu opens; a click starts the preparation on its own and every
// later phase waits for its own click in the Project tab. While a release is on its way the button says which. When
// the header's next station is a milestone's other number, that planned version comes first and the computed one
// stays beside it (#2268).

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { nextStation } from "../project/next-station-model";
import { DominoLoader } from "../suite/suite";
import { ActionRunningClass, ActionSecondaryClass, RunningDot } from "./action-button";
import { Milestone } from "./github";
import { MenuPopover } from "./menu-popover";
import { missionRefresh, missionTrust, PipelineDrift, releaseMilestone, releaseStart } from "./mission-client";
import { PipelineReleaseStep, toTreeData, UntrustedInfo } from "./mission-model";
import { openSetupTab } from "./pipeline-tab-open";
import {
    computedReasonText,
    milestoneWarning,
    MilestoneWarning,
    plannedConfirmText,
    PlannedRelease,
    plannedRelease,
    releaseBaseOf,
    ReleaseChannel,
    releaseChoiceTag,
    releaseNote,
    ReleasePlan,
    releasePlan,
    ReleaseSession,
} from "./release-model";
import { setupCheck } from "./release-setup-client";
import { needsReleaseSetup, SetupCheck, setupReasonText, SetupUpdateReason } from "./release-setup-model";
import type { StepperStep } from "./release-setup-stepper";
import { TechDocLinkButton } from "./release-techdoc-link";
import { TrustPrompt } from "./runs-view";
import { releaseState, treeRules } from "./versions";

const MilestoneReadDelayMs = 300;

export function ReleaseMenu({
    dir,
    projectName,
    session,
    rcSteps,
    publicSteps,
    milestones,
    onStarted,
    onShowRelease,
}: {
    dir: string;
    projectName: string;
    session: ReleaseSession;
    rcSteps: PipelineReleaseStep[];
    publicSteps: PipelineReleaseStep[];
    // The project's open milestones, as the header reads them: the next station's number is offered first (#2268).
    milestones?: readonly Milestone[];
    onStarted: () => void;
    onShowRelease: () => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [plan, setPlan] = useState<ReleasePlan>(null);
    const [planned, setPlanned] = useState<PlannedRelease>(null);
    const [choice, setChoice] = useState<ReleaseChannel>(null);
    // The choice is the planned version's rather than the computed one's.
    const [fromPlan, setFromPlan] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [confirmedTag, setConfirmedTag] = useState<string>(null);
    // Read when the menu opens, not followed: a snapshot refresh must not reset a choice in progress.
    const milestonesRef = useRef(milestones);
    milestonesRef.current = milestones;
    const [version, setVersion] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const [setupError, setSetupError] = useState<string>(null);
    const [untrusted, setUntrusted] = useState<UntrustedInfo>(null);
    const [drift, setDrift] = useState<PipelineDrift>(null);
    const [anchor, setAnchor] = useState<HTMLDivElement>(null);
    const [setupState, setSetupState] = useState<SetupCheck>(null);
    const [milestone, setMilestone] = useState<{ version: string; warning: MilestoneWarning; error: string }>(null);

    // The numbers are computed when the menu opens, from the remote as it is now.
    useEffect(() => {
        if (!open) {
            return;
        }
        setPlan(null);
        setPlanned(null);
        setChoice(null);
        setFromPlan(false);
        setConfirming(false);
        setConfirmedTag(null);
        setError(null);
        setDrift(null);
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const snap = await missionRefresh(dir);
                if (cancelled) {
                    return;
                }
                if (snap?.git == null) {
                    setError(snap?.giterror || t("mc.releaseMenu.noHistory"));
                    return;
                }
                const tree = toTreeData(snap.git);
                const rules = treeRules(tree);
                const state = releaseState(tree.tags, snap.git.ahead ?? [], snap.git.sincepublic ?? [], rules);
                const next = releasePlan(
                    state,
                    tree.tags.map((tagRef) => tagRef.name),
                    rules
                );
                setPlan(next);
                setPlanned(plannedRelease(next, nextStation(snap.git, null, milestonesRef.current)));
                setVersion(next.publicVersion ?? "");
            } catch (e) {
                if (!cancelled) {
                    setError(serverErrorText(e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, dir]);

    // A pipeline set up before: checked again each time the menu opens, the release branch's protection included (#1086).
    // A pipeline missing a channel is checked too: its technical documentation is linked all the same (FR-MC-043), and
    // the check answers "missing" without reading the remote.
    const missingSetup = needsReleaseSetup(rcSteps, publicSteps);
    useEffect(() => {
        setSetupState(null);
        if (!open) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const answer = await setupCheck(dir);
                if (!cancelled) {
                    setSetupState(answer);
                }
            } catch {
                // The menu stays usable: the check only adds an offer.
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, dir, missingSetup]);

    const offered = planned?.refused ? null : planned;
    const tag =
        fromPlan && offered
            ? choice === "rc"
                ? offered.rc
                : choice === "public"
                  ? offered.tag
                  : null
            : releaseChoiceTag(plan, choice, version);
    const shipped = releaseBaseOf(plan?.rules, tag);

    // The milestone the chosen release ships, read once the choice is made: its open issues are listed, never blocking.
    useEffect(() => {
        if (!open || !shipped) {
            setMilestone(null);
            return;
        }
        let cancelled = false;
        // A first public number being typed passes through valid versions: only the one it settles on is read.
        const timer = setTimeout(() => {
            fireAndForget(async () => {
                try {
                    const found = await releaseMilestone(dir, shipped);
                    if (!cancelled) {
                        setMilestone({ version: shipped, warning: milestoneWarning(shipped, found), error: null });
                    }
                } catch (e) {
                    if (!cancelled) {
                        setMilestone({ version: shipped, warning: null, error: serverErrorText(e) });
                    }
                }
            });
        }, MilestoneReadDelayMs);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, dir, shipped]);

    if (session != null) {
        return (
            <button type="button" onClick={onShowRelease} className={ActionRunningClass}>
                <RunningDot />
                {t("mc.releaseMenu.running", { tag: session.tag })}
            </button>
        );
    }

    const steps = choice === "rc" ? rcSteps : publicSteps;
    const pick = (channel: ReleaseChannel, planOffer: boolean) => {
        setChoice(channel);
        setFromPlan(planOffer);
        setConfirming(false);
    };
    const launch = (force?: boolean, confirmed?: boolean) =>
        fireAndForget(async () => {
            if (!tag || !choice) {
                return;
            }
            // The commits call for a bigger bump than the planned number: said once, never blocking (#2268).
            if (fromPlan && offered?.confirm && !confirmed && confirmedTag !== tag) {
                setConfirming(true);
                return;
            }
            if (confirmed) {
                setConfirmedTag(tag);
            }
            setConfirming(false);
            setBusy(true);
            setError(null);
            setDrift(null);
            try {
                const result = await releaseStart(dir, choice, tag, force);
                if (result?.untrusted) {
                    setUntrusted(result.untrusted);
                    return;
                }
                if (result?.pipelinedrift) {
                    setDrift(result.pipelinedrift);
                    return;
                }
                setOpen(false);
                onStarted();
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy(false);
            }
        });
    const trustAndLaunch = () =>
        fireAndForget(async () => {
            const info = untrusted;
            setUntrusted(null);
            try {
                await missionTrust(dir, info.hash);
                launch();
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    // An update opens at step 2 (#1102); a setup where it was left.
    const openSetup = (openAt?: StepperStep) => {
        setOpen(false);
        setSetupError(null);
        openSetupTab(dir, projectName, openAt, setSetupError);
    };
    const publicTitle =
        plan?.publicVersion && !plan.publicIsDecision
            ? t("mc.releaseMenu.publicTitle", { tag: plan.prefix + plan.publicVersion })
            : t("mc.releaseMenu.public");
    return (
        <div ref={setAnchor} className="relative">
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={ActionSecondaryClass}>
                <i className="fa fa-solid fa-rocket text-11" />
                {t("mc.releaseMenu.release")}
            </button>
            {open ? (
                <MenuPopover anchor={anchor} onClose={() => setOpen(false)} className="flex w-80 flex-col gap-2">
                    {missingSetup ? <ReleaseSetupButton onOpen={() => openSetup()} /> : null}
                    {setupState?.state === "update" ? (
                        <ReleaseSetupUpdateButton
                            reason={setupState.reasons[0]}
                            onOpen={() => openSetup("understand")}
                        />
                    ) : null}
                    {setupState?.state === "uptodate" ? (
                        <div
                            className="flex items-start gap-1.5 px-1 text-11 text-muted"
                            data-testid="release-setup-uptodate"
                        >
                            <i className="fa fa-solid fa-check mt-[2px] text-11 text-success" />
                            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                                {t("mc.setup.update.upToDate")}
                                <button
                                    type="button"
                                    onClick={() => openSetup("understand")}
                                    className="cursor-pointer text-11 text-accent hover:underline"
                                    data-testid="release-setup-reopen"
                                >
                                    {t("mc.setup.update.openSetup")}
                                </button>
                            </span>
                        </div>
                    ) : null}
                    {setupState?.doc ? <TechDocLinkButton doc={setupState.doc} onOpen={() => setOpen(false)} /> : null}
                    {plan == null && error == null ? (
                        <div className="flex items-center gap-2 py-2 text-12 text-muted">
                            <DominoLoader />
                            {t("mc.releaseMenu.computing")}
                        </div>
                    ) : null}
                    {plan != null ? (
                        <>
                            {offered ? (
                                <>
                                    <MenuSection testId="release-planned-heading">
                                        {t("mc.releaseMenu.plannedHeading", { tag: offered.tag })}
                                    </MenuSection>
                                    <ChannelButton
                                        channel="rc"
                                        selected={choice === "rc" && fromPlan}
                                        disabled={!offered.rc || rcSteps.length === 0}
                                        onPick={() => pick("rc", true)}
                                        title={t("mc.releaseMenu.rcTitle", { tag: offered.rc ?? "" })}
                                        hint={
                                            rcSteps.length ? t("mc.releaseMenu.rcHint") : t("mc.releaseMenu.noRcSteps")
                                        }
                                        testId="release-planned-rc"
                                    />
                                    <ChannelButton
                                        channel="public"
                                        selected={choice === "public" && fromPlan}
                                        disabled={publicSteps.length === 0}
                                        onPick={() => pick("public", true)}
                                        title={t("mc.releaseMenu.publicTitle", { tag: offered.tag })}
                                        hint={
                                            publicSteps.length === 0
                                                ? t("mc.releaseMenu.noPublicSteps")
                                                : t("mc.releaseMenu.publicHint")
                                        }
                                        testId="release-planned-public"
                                    />
                                    <MenuSection testId="release-computed-heading">
                                        {t("mc.releaseMenu.computedHeading")}
                                    </MenuSection>
                                    <div className="px-1 text-11 text-muted" data-testid="release-computed-reason">
                                        {computedReasonText(plan)}
                                    </div>
                                </>
                            ) : null}
                            {planned?.refused ? (
                                <div className="px-1 text-11 text-muted" data-testid="release-planned-refused">
                                    {planned.refused}
                                </div>
                            ) : null}
                            <ChannelButton
                                channel="rc"
                                selected={choice === "rc" && !fromPlan}
                                disabled={!plan.rc || rcSteps.length === 0}
                                onPick={() => pick("rc", false)}
                                title={t("mc.releaseMenu.rcTitle", { tag: plan.rc ?? "" })}
                                hint={rcSteps.length ? t("mc.releaseMenu.rcHint") : t("mc.releaseMenu.noRcSteps")}
                            />
                            <ChannelButton
                                channel="public"
                                selected={choice === "public" && !fromPlan}
                                disabled={!plan.publicVersion || publicSteps.length === 0}
                                onPick={() => pick("public", false)}
                                title={publicTitle}
                                hint={
                                    publicSteps.length === 0
                                        ? t("mc.releaseMenu.noPublicSteps")
                                        : plan.publicVersion
                                          ? t("mc.releaseMenu.publicHint")
                                          : plan.reason
                                }
                            />
                            {choice === "public" && plan.publicIsDecision ? (
                                <label className="flex flex-col gap-1 text-11 text-muted">
                                    {t("mc.releaseMenu.firstNumber")}
                                    <input
                                        value={version}
                                        onChange={(e) => setVersion(e.target.value.trim())}
                                        aria-invalid={tag == null}
                                        className={cn(
                                            "rounded-4 border bg-transparent px-2 py-1 font-mono text-12 text-primary",
                                            tag == null ? "border-error/60" : "border-border"
                                        )}
                                    />
                                </label>
                            ) : null}
                            {choice && milestone?.version === shipped ? (
                                <MilestoneNote warning={milestone.warning} error={milestone.error} />
                            ) : null}
                            {choice ? (
                                <div className="rounded-4 border border-border bg-hover/40 p-2 text-11 text-muted">
                                    {releaseNote(steps)}
                                </div>
                            ) : null}
                            {drift ? (
                                <PipelineDriftNote drift={drift} busy={busy} onStart={() => launch(true)} />
                            ) : null}
                            {confirming && tag ? (
                                <PlannedConfirm
                                    text={plannedConfirmText(plan, tag)}
                                    tag={tag}
                                    busy={busy}
                                    onStart={() => launch(false, true)}
                                    onBack={() => setConfirming(false)}
                                />
                            ) : null}
                            <button
                                type="button"
                                disabled={!tag || busy || confirming}
                                onClick={() => launch()}
                                className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                            >
                                {busy ? <DominoLoader className="mr-1.5" /> : null}
                                {tag ? t("mc.releaseMenu.start", { tag }) : t("mc.releaseMenu.choose")}
                                <MoltenWave />
                            </button>
                        </>
                    ) : null}
                    {error ? <div className="text-12 text-danger">{error}</div> : null}
                </MenuPopover>
            ) : null}
            {setupError ? (
                <div
                    className="absolute top-full right-0 mt-1 w-72 text-11 text-danger"
                    data-testid="release-setup-error"
                >
                    {setupError}
                </div>
            ) : null}
            {untrusted != null ? (
                <TrustPrompt
                    projectName={projectName}
                    dir={dir}
                    info={untrusted}
                    onTrust={trustAndLaunch}
                    onCancel={() => setUntrusted(null)}
                />
            ) : null}
        </div>
    );
}

function MenuSection({ children, testId }: { children: React.ReactNode; testId?: string }) {
    return (
        <div className="px-1 pt-1 text-11 font-semibold text-secondary" data-testid={testId}>
            {children}
        </div>
    );
}

function ChannelButton({
    channel,
    selected,
    disabled,
    onPick,
    title,
    hint,
    testId,
}: {
    channel: ReleaseChannel;
    selected: boolean;
    disabled: boolean;
    onPick: () => void;
    title: string;
    hint: string;
    testId?: string;
}) {
    const selectedClass = channel === "rc" ? "border-accent/60 bg-accent/10" : "border-warning/60 bg-warning/10";
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onPick}
            aria-pressed={selected}
            className={cn(
                "w-full cursor-pointer rounded-6 border px-3 py-2 text-left transition-colors duration-120 ease-mt disabled:cursor-default disabled:opacity-50",
                selected ? selectedClass : "border-border hover:border-secondary/40"
            )}
            data-testid={testId}
        >
            <div className="text-13 leading-5 font-medium text-primary">{title}</div>
            <div className="text-11 text-muted">{hint}</div>
        </button>
    );
}

// The planned number is smaller than the commits call for: the reason, then the developer's word (#2268).
function PlannedConfirm({
    text,
    tag,
    busy,
    onStart,
    onBack,
}: {
    text: string;
    tag: string;
    busy: boolean;
    onStart: () => void;
    onBack: () => void;
}) {
    const t = useT();
    return (
        <div
            className="flex flex-col gap-2 rounded-4 border border-warning/50 bg-warning/10 p-2 text-11 text-primary"
            data-testid="release-planned-confirm"
        >
            <div className="flex items-start gap-1.5">
                <i className="fa fa-solid fa-triangle-exclamation mt-[2px] text-11 text-warning" />
                <span>{text}</span>
            </div>
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="cursor-pointer rounded-6 px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                    data-testid="release-planned-back"
                >
                    {t("mc.releaseMenu.plannedBack")}
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onStart}
                    className="cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50"
                    data-testid="release-planned-start"
                >
                    {t("mc.releaseMenu.start", { tag })}
                </button>
            </div>
        </div>
    );
}

// The menu's first choice when the pipeline cannot start a release candidate or a public release (FR-MC-036).
export function ReleaseSetupButton({ onOpen }: { onOpen: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onOpen}
            className="flex w-full cursor-pointer items-start gap-2 rounded-6 border border-accent/50 bg-accent/10 px-3 py-2 text-left transition-colors duration-120 ease-mt hover:border-accent"
            data-testid="release-setup-open"
        >
            <i className="fa fa-solid fa-wand-magic-sparkles mt-[3px] text-11 text-accent" />
            <span className="flex flex-col">
                <span className="text-13 leading-5 font-medium text-primary">{t("mc.setup.open")}</span>
                <span className="text-11 text-muted">{t("mc.setup.openHint")}</span>
            </span>
        </button>
    );
}

// The menu's offer when this version of MoltenTerm writes the release setup differently (#1086), with the first reason.
export function ReleaseSetupUpdateButton({ reason, onOpen }: { reason: SetupUpdateReason; onOpen: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onOpen}
            className="flex w-full cursor-pointer items-start gap-2 rounded-6 border border-accent/50 bg-accent/10 px-3 py-2 text-left transition-colors duration-120 ease-mt hover:border-accent"
            data-testid="release-setup-update"
        >
            <i className="fa fa-solid fa-arrows-rotate mt-[3px] text-11 text-accent" />
            <span className="flex flex-col">
                <span className="text-13 leading-5 font-medium text-primary">{t("mc.setup.update.open")}</span>
                <span className="text-11 text-muted">
                    {reason ? setupReasonText(t, reason) : t("mc.setup.update.openHint")}
                </span>
            </span>
        </button>
    );
}

// The Project header's entry when the project has no pipeline yet (FR-MC-036).
export function ReleaseSetupEntry({ dir, projectName }: { dir: string; projectName: string }) {
    const t = useT();
    const [error, setError] = useState<string>(null);
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => {
                    setError(null);
                    openSetupTab(dir, projectName, undefined, setError);
                }}
                className={ActionSecondaryClass}
                data-testid="release-setup-entry"
            >
                <i className="fa fa-solid fa-rocket text-11" />
                {t("mc.setup.open")}
            </button>
            {error ? (
                <div
                    className="absolute top-full right-0 mt-1 w-72 text-11 text-danger"
                    data-testid="release-setup-error"
                >
                    {error}
                </div>
            ) : null}
        </div>
    );
}

// The checkout's pipeline is not the one the release branch is made from (#1095): nothing started, the developer may
// start anyway.
function PipelineDriftNote({ drift, busy, onStart }: { drift: PipelineDrift; busy: boolean; onStart: () => void }) {
    const t = useT();
    return (
        <div
            className="flex flex-col gap-2 rounded-4 border border-warning/50 bg-warning/10 p-2 text-11 text-primary"
            data-testid="release-pipeline-drift"
        >
            <div className="flex items-start gap-1.5">
                <i className="fa fa-solid fa-triangle-exclamation mt-[2px] text-11 text-warning" />
                <span className="flex flex-col gap-1">
                    {drift.uncommitted ? <span>{t("mc.releaseMenu.driftUncommitted")}</span> : null}
                    {drift.base ? <span>{t("mc.releaseMenu.driftBase", { base: drift.base })}</span> : null}
                    <span className="text-muted">{t("mc.releaseMenu.driftHint")}</span>
                </span>
            </div>
            <div className="flex justify-end">
                <button
                    type="button"
                    disabled={busy}
                    onClick={onStart}
                    className="cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50"
                    data-testid="release-start-anyway"
                >
                    {t("mc.releaseMenu.startAnyway")}
                </button>
            </div>
        </div>
    );
}

function MilestoneNote({ warning, error }: { warning: MilestoneWarning; error: string }) {
    const t = useT();
    if (error) {
        return <div className="text-11 text-muted">{t("mc.releaseMenu.milestoneError", { error })}</div>;
    }
    return (
        <div
            className={cn(
                "flex flex-col gap-1 rounded-4 border p-2 text-11",
                warning.warn ? "border-warning/50 bg-warning/10 text-primary" : "border-border text-muted"
            )}
        >
            <div className="flex items-start gap-1.5">
                {warning.warn ? (
                    <i className="fa fa-solid fa-triangle-exclamation mt-[2px] text-11 text-warning" />
                ) : null}
                <span>{warning.text}</span>
            </div>
            {warning.issues.length ? (
                <ul className="flex flex-col gap-0.5 pl-4">
                    {warning.issues.map((issue) => (
                        <li key={issue.number} className="truncate text-muted">
                            #{issue.number} {issue.title}
                        </li>
                    ))}
                    {warning.more ? (
                        <li className="text-muted">{t("mc.releaseMenu.andMore", { count: warning.more })}</li>
                    ) : null}
                </ul>
            ) : null}
        </div>
    );
}
