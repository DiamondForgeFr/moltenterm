// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project header's Release menu (FR-MC-015), as Notulia's ReleaseLauncher: the next release candidate and the next
// public release with their numbers, computed when the menu opens; a click starts the preparation on its own and every
// later phase waits for its own click in the Project tab. While a release is on its way the button says which.

import { cn, fireAndForget } from "@/util/util";
import { lazy, Suspense, useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { ActionRunningClass, ActionSecondaryClass, RunningDot } from "./action-button";
import { MenuPopover } from "./menu-popover";
import { missionRefresh, missionTrust, PipelineDrift, releaseMilestone, releaseStart } from "./mission-client";
import { PipelineReleaseStep, toTreeData, UntrustedInfo } from "./mission-model";
import {
    milestoneWarning,
    MilestoneWarning,
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
import { TechDocLinkButton } from "./release-techdoc-link";
import { TrustPrompt } from "./runs-view";
import { releaseState, treeRules } from "./versions";

// The release setup's dialogs load on their first opening, out of the entry every tab view evaluates (NFR-PERF-003).
const ReleaseSetup = lazy(() => import("./release-setup").then((m) => ({ default: m.ReleaseSetup })));

const MilestoneReadDelayMs = 300;

export function ReleaseMenu({
    dir,
    projectName,
    session,
    rcSteps,
    publicSteps,
    onStarted,
    onShowRelease,
    onSetUp,
}: {
    dir: string;
    projectName: string;
    session: ReleaseSession;
    rcSteps: PipelineReleaseStep[];
    publicSteps: PipelineReleaseStep[];
    onStarted: () => void;
    onShowRelease: () => void;
    // The release setup wrote the pipeline (FR-MC-036): the header reads it again.
    onSetUp?: () => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [plan, setPlan] = useState<ReleasePlan>(null);
    const [choice, setChoice] = useState<ReleaseChannel>(null);
    const [version, setVersion] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const [untrusted, setUntrusted] = useState<UntrustedInfo>(null);
    const [drift, setDrift] = useState<PipelineDrift>(null);
    const [anchor, setAnchor] = useState<HTMLDivElement>(null);
    // The stepper, and the step it opens at: an update opens at step 2 (#1102).
    const [settingUp, setSettingUp] = useState(false);
    const [setupAt, setSetupAt] = useState<"understand">(null);
    const [setupState, setSetupState] = useState<SetupCheck>(null);
    const [milestone, setMilestone] = useState<{ version: string; warning: MilestoneWarning; error: string }>(null);

    // The numbers are computed when the menu opens, from the remote as it is now.
    useEffect(() => {
        if (!open) {
            return;
        }
        setPlan(null);
        setChoice(null);
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

    const tag = releaseChoiceTag(plan, choice, version);
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
    const launch = (force?: boolean) =>
        fireAndForget(async () => {
            if (!tag || !choice) {
                return;
            }
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
                    {missingSetup ? (
                        <ReleaseSetupButton
                            onOpen={() => {
                                setOpen(false);
                                setSettingUp(true);
                            }}
                        />
                    ) : null}
                    {setupState?.state === "update" ? (
                        <ReleaseSetupUpdateButton
                            reason={setupState.reasons[0]}
                            onOpen={() => {
                                setOpen(false);
                                setSetupAt("understand");
                                setSettingUp(true);
                            }}
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
                                    onClick={() => {
                                        setOpen(false);
                                        setSetupAt("understand");
                                        setSettingUp(true);
                                    }}
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
                            <button
                                type="button"
                                disabled={!plan.rc || rcSteps.length === 0}
                                onClick={() => setChoice("rc")}
                                className={cn(
                                    "w-full cursor-pointer rounded-6 border px-3 py-2 text-left transition-colors duration-120 ease-mt disabled:cursor-default disabled:opacity-50",
                                    choice === "rc"
                                        ? "border-accent/60 bg-accent/10"
                                        : "border-border hover:border-secondary/40"
                                )}
                            >
                                <div className="text-13 leading-5 font-medium text-primary">
                                    {t("mc.releaseMenu.rcTitle", { tag: plan.rc ?? "" })}
                                </div>
                                <div className="text-11 text-muted">
                                    {rcSteps.length ? t("mc.releaseMenu.rcHint") : t("mc.releaseMenu.noRcSteps")}
                                </div>
                            </button>
                            <button
                                type="button"
                                disabled={!plan.publicVersion || publicSteps.length === 0}
                                onClick={() => setChoice("public")}
                                className={cn(
                                    "w-full cursor-pointer rounded-6 border px-3 py-2 text-left transition-colors duration-120 ease-mt disabled:cursor-default disabled:opacity-50",
                                    choice === "public"
                                        ? "border-warning/60 bg-warning/10"
                                        : "border-border hover:border-secondary/40"
                                )}
                            >
                                <div className="text-13 leading-5 font-medium text-primary">{publicTitle}</div>
                                <div className="text-11 text-muted">
                                    {publicSteps.length === 0
                                        ? t("mc.releaseMenu.noPublicSteps")
                                        : plan.publicVersion
                                          ? t("mc.releaseMenu.publicHint")
                                          : plan.reason}
                                </div>
                            </button>
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
                            <button
                                type="button"
                                disabled={!tag || busy}
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
            {settingUp ? (
                <Suspense fallback={null}>
                    <ReleaseSetup
                        dir={dir}
                        projectName={projectName}
                        onClose={() => {
                            setSettingUp(false);
                            setSetupAt(null);
                        }}
                        onWritten={() => onSetUp?.()}
                        openAt={setupAt ?? undefined}
                    />
                </Suspense>
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
export function ReleaseSetupEntry({
    dir,
    projectName,
    onSetUp,
}: {
    dir: string;
    projectName: string;
    onSetUp: () => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={ActionSecondaryClass}
                data-testid="release-setup-entry"
            >
                <i className="fa fa-solid fa-rocket text-11" />
                {t("mc.setup.open")}
            </button>
            {open ? (
                <Suspense fallback={null}>
                    <ReleaseSetup
                        dir={dir}
                        projectName={projectName}
                        onClose={() => setOpen(false)}
                        onWritten={onSetUp}
                    />
                </Suspense>
            ) : null}
        </>
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
