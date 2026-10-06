// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project header's Release menu (FR-MC-015), as Notulia's ReleaseLauncher: the next release candidate and the next
// public release with their numbers, computed when the menu opens; a click starts the preparation on its own and every
// later phase waits for its own click in the Project tab. While a release is on its way the button says which.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { MoltenWave } from "../molten-button";
import { ActionRunningClass, ActionSecondaryClass, RunningDot } from "./action-button";
import { MenuPopover } from "./menu-popover";
import { missionRefresh, missionTrust, releaseStart } from "./mission-client";
import { PipelineReleaseStep, toTreeData, UntrustedInfo } from "./mission-model";
import {
    ReleaseChannel,
    releaseChoiceTag,
    releaseNote,
    ReleasePlan,
    releasePlan,
    ReleaseSession,
} from "./release-model";
import { TrustPrompt } from "./runs-view";
import { releaseState, treeRules } from "./versions";

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
    const [open, setOpen] = useState(false);
    const [plan, setPlan] = useState<ReleasePlan>(null);
    const [choice, setChoice] = useState<ReleaseChannel>(null);
    const [version, setVersion] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const [untrusted, setUntrusted] = useState<UntrustedInfo>(null);
    const [anchor, setAnchor] = useState<HTMLDivElement>(null);

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
                    setError(snap?.giterror || "The project's git history could not be read.");
                    return;
                }
                const tree = toTreeData(snap.git);
                const rules = treeRules(tree);
                const state = releaseState(tree.tags, snap.git.ahead ?? [], snap.git.sincepublic ?? [], rules);
                const next = releasePlan(
                    state,
                    tree.tags.map((t) => t.name),
                    rules
                );
                setPlan(next);
                setVersion(next.publicVersion ?? "");
            } catch (e) {
                if (!cancelled) {
                    setError(String(e?.message ?? e));
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, dir]);

    if (session != null) {
        return (
            <button type="button" onClick={onShowRelease} className={ActionRunningClass}>
                <RunningDot />
                Release {session.tag}
            </button>
        );
    }

    const tag = releaseChoiceTag(plan, choice, version);
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
                setError(String(e?.message ?? e));
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
                setError(String(e?.message ?? e));
            }
        });
    const publicTitle =
        plan?.publicVersion && !plan.publicIsDecision
            ? `Public release ${plan.prefix}${plan.publicVersion}`
            : "Public release";
    return (
        <div ref={setAnchor} className="relative">
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={ActionSecondaryClass}>
                <i className="fa fa-solid fa-rocket text-[10px]" />
                Release
            </button>
            {open ? (
                <MenuPopover anchor={anchor} onClose={() => setOpen(false)} className="flex w-80 flex-col gap-2">
                    {plan == null && error == null ? (
                        <div className="flex items-center gap-2 py-2 text-xs text-muted">
                            <i className="fa fa-solid fa-circle-notch fa-spin text-[11px]" />
                            Computing the numbers…
                        </div>
                    ) : null}
                    {plan != null ? (
                        <>
                            <button
                                type="button"
                                disabled={!plan.rc || rcSteps.length === 0}
                                onClick={() => setChoice("rc")}
                                className={cn(
                                    "w-full cursor-pointer rounded border px-3 py-2 text-left transition-colors disabled:cursor-default disabled:opacity-50",
                                    choice === "rc"
                                        ? "border-accent/60 bg-accent/10"
                                        : "border-border hover:border-secondary/40"
                                )}
                            >
                                <div className="text-sm font-medium text-primary">
                                    Release candidate {plan.rc ?? ""}
                                </div>
                                <div className="text-[11px] text-muted">
                                    {rcSteps.length
                                        ? "Internal: offered to nobody, installable by hand."
                                        : "The pipeline declares no release.rc steps."}
                                </div>
                            </button>
                            <button
                                type="button"
                                disabled={!plan.publicVersion || publicSteps.length === 0}
                                onClick={() => setChoice("public")}
                                className={cn(
                                    "w-full cursor-pointer rounded border px-3 py-2 text-left transition-colors disabled:cursor-default disabled:opacity-50",
                                    choice === "public"
                                        ? "border-warning/60 bg-warning/10"
                                        : "border-border hover:border-secondary/40"
                                )}
                            >
                                <div className="text-sm font-medium text-primary">{publicTitle}</div>
                                <div className="text-[11px] text-muted">
                                    {publicSteps.length === 0
                                        ? "The pipeline declares no release.public steps."
                                        : plan.publicVersion
                                          ? "Goes to all users on publication."
                                          : plan.reason}
                                </div>
                            </button>
                            {choice === "public" && plan.publicIsDecision ? (
                                <label className="flex flex-col gap-1 text-[11px] text-muted">
                                    The first public release's number: a choice, not a calculation
                                    <input
                                        value={version}
                                        onChange={(e) => setVersion(e.target.value.trim())}
                                        aria-invalid={tag == null}
                                        className={cn(
                                            "rounded border bg-transparent px-2 py-1 font-mono text-xs text-primary",
                                            tag == null ? "border-error/60" : "border-border"
                                        )}
                                    />
                                </label>
                            ) : null}
                            {choice ? (
                                <div className="rounded border border-border bg-hover/40 p-2 text-[11px] text-muted">
                                    {releaseNote(steps)}
                                </div>
                            ) : null}
                            <button
                                type="button"
                                disabled={!tag || busy}
                                onClick={launch}
                                className="molten-btn cursor-pointer rounded px-3 py-1.5 text-xs disabled:cursor-default disabled:opacity-50"
                            >
                                {busy ? <i className="fa fa-solid fa-circle-notch fa-spin mr-1.5 text-[10px]" /> : null}
                                {tag ? `Start ${tag}` : "Choose a release"}
                                <MoltenWave />
                            </button>
                        </>
                    ) : null}
                    {error ? <div className="text-xs text-error">{error}</div> : null}
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
