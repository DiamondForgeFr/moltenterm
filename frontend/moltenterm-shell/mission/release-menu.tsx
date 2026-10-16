// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project header's Release menu (FR-MC-015), as Notulia's ReleaseLauncher: the next release candidate and the next
// public release with their numbers, computed when the menu opens; a click starts the preparation on its own and every
// later phase waits for its own click in the Project tab. While a release is on its way the button says which.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { ActionRunningClass, ActionSecondaryClass, RunningDot } from "./action-button";
import { MenuPopover } from "./menu-popover";
import { missionRefresh, missionTrust, releaseMilestone, releaseStart } from "./mission-client";
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
import { TrustPrompt } from "./runs-view";
import { releaseState, treeRules } from "./versions";

const MilestoneReadDelayMs = 300;

export function ReleaseMenu({
    dir,
    projectName,
    session,
    rcSteps,
    publicSteps,
    onStarted,
    onShowRelease,
}: {
    dir: string;
    projectName: string;
    session: ReleaseSession;
    rcSteps: PipelineReleaseStep[];
    publicSteps: PipelineReleaseStep[];
    onStarted: () => void;
    onShowRelease: () => void;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [plan, setPlan] = useState<ReleasePlan>(null);
    const [choice, setChoice] = useState<ReleaseChannel>(null);
    const [version, setVersion] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const [untrusted, setUntrusted] = useState<UntrustedInfo>(null);
    const [anchor, setAnchor] = useState<HTMLDivElement>(null);
    const [milestone, setMilestone] = useState<{ version: string; warning: MilestoneWarning; error: string }>(null);

    // The numbers are computed when the menu opens, from the remote as it is now.
    useEffect(() => {
        if (!open) {
            return;
        }
        setPlan(null);
        setChoice(null);
        setError(null);
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
    const launch = () =>
        fireAndForget(async () => {
            if (!tag || !choice) {
                return;
            }
            setBusy(true);
            setError(null);
            try {
                const result = await releaseStart(dir, choice, tag);
                if (result?.untrusted) {
                    setUntrusted(result.untrusted);
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
                            <button
                                type="button"
                                disabled={!tag || busy}
                                onClick={launch}
                                className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                            >
                                {busy ? <DominoLoader className="mr-1.5" /> : null}
                                {tag ? t("mc.releaseMenu.start", { tag }) : t("mc.releaseMenu.choose")}
                                <MoltenWave />
                            </button>
                        </>
                    ) : null}
                    {error ? <div className="text-12 text-error">{error}</div> : null}
                </MenuPopover>
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
