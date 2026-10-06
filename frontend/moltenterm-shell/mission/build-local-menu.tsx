// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project header's Build local menu (FR-MC-012), as Notulia's: one card per build the project declares, with what
// it is, where the CI stands for a build it gates and the last build delivered, then a confirmation. While a build runs
// the button says so.

import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { MoltenWave } from "../molten-button";
import { pathParent } from "../workspace-project";
import { ActionRunningClass, ActionSecondaryClass, RunningDot } from "./action-button";
import { buildCardTitle, BuildFacts, BuildsFacts, ciLine, lastBuildLine } from "./builds-model";
import { MenuPopover } from "./menu-popover";
import { missionBuilds } from "./mission-client";
import { RunRecord } from "./mission-model";

function revealBuild(build: BuildFacts) {
    const target = build.last?.app && build.artifact ? pathParent(build.artifact) : build.artifact || build.manifest;
    if (target) {
        getApi().openNativePath(target);
    }
}

export function BuildLocalMenu({
    dir,
    projectName,
    running,
    onBuild,
    onShowRun,
}: {
    dir: string;
    projectName: string;
    running: RunRecord;
    onBuild: (buildId: string) => Promise<string>;
    onShowRun: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [facts, setFacts] = useState<BuildsFacts>(null);
    const [fetching, setFetching] = useState(false);
    const [choice, setChoice] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const [anchor, setAnchor] = useState<HTMLDivElement>(null);

    // The trunk as the remote has it, when the menu opens.
    useEffect(() => {
        if (!open) {
            return;
        }
        setChoice(null);
        setError(null);
        setFetching(true);
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await missionBuilds(dir, true);
                if (!cancelled) {
                    setFacts(next);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(String(e?.message ?? e));
                }
            } finally {
                if (!cancelled) {
                    setFetching(false);
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, dir]);

    if (running != null) {
        return (
            <button type="button" onClick={onShowRun} className={ActionRunningClass}>
                <RunningDot />
                Build {running.title}…
            </button>
        );
    }

    const builds = facts?.builds ?? [];
    const chosen = builds.find((b) => b.id === choice);
    const now = Date.now();
    const launch = () =>
        fireAndForget(async () => {
            if (!chosen) {
                return;
            }
            setBusy(true);
            setError(null);
            try {
                const failure = await onBuild(chosen.id);
                if (failure) {
                    setError(failure);
                    return;
                }
                setOpen(false);
                onShowRun();
            } finally {
                setBusy(false);
            }
        });
    return (
        <div ref={setAnchor} className="relative">
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={ActionSecondaryClass}>
                <i className="fa fa-solid fa-hammer text-[10px]" />
                Build local
            </button>
            {open ? (
                <MenuPopover anchor={anchor} onClose={() => setOpen(false)} className="flex w-80 flex-col gap-2">
                    {builds.length === 0 && !fetching ? (
                        <div className="text-xs text-muted">The pipeline declares no build (builds).</div>
                    ) : null}
                    {builds.map((build) => (
                        <div key={build.id} className="relative">
                            <button
                                type="button"
                                onClick={() => setChoice(build.id)}
                                className={cn(
                                    "w-full cursor-pointer rounded border px-3 py-2 text-left transition-colors",
                                    choice === build.id
                                        ? build.kind === "rc"
                                            ? "border-orange-500/60 bg-orange-500/10"
                                            : "border-yellow-500/60 bg-yellow-500/10"
                                        : "border-border hover:border-secondary/40"
                                )}
                            >
                                <div className="text-sm font-medium text-primary">
                                    {buildCardTitle(projectName, build)}
                                </div>
                                {build.description ? (
                                    <div className="text-[11px] text-muted">{build.description}</div>
                                ) : null}
                                {build.verify === "ci" ? (
                                    <div className="mt-0.5 text-[11px] text-muted">{ciLine(facts)}</div>
                                ) : null}
                                <div className="mt-0.5 pr-6 text-[11px] text-muted">
                                    {lastBuildLine(build.last, now)}
                                </div>
                            </button>
                            {build.last ? (
                                <button
                                    type="button"
                                    title="Show in Finder"
                                    aria-label={`Show ${buildCardTitle(projectName, build)} in Finder`}
                                    onClick={() => revealBuild(build)}
                                    className="absolute right-1.5 bottom-1.5 cursor-pointer rounded p-1 text-muted transition-colors hover:bg-hover hover:text-primary"
                                >
                                    <i className="fa fa-regular fa-folder-open text-[12px]" />
                                </button>
                            ) : null}
                        </div>
                    ))}
                    <div className="flex items-start gap-1.5 rounded border border-border bg-hover/40 p-2 text-[11px] text-muted">
                        {fetching ? (
                            <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin mt-0.5 text-[10px]" />
                        ) : null}
                        <span>
                            Built from {facts?.trunk || "the trunk"} as it is on GitHub, in a separate worktree, then
                            delivered to the local builds folder.
                        </span>
                    </div>
                    <button
                        type="button"
                        disabled={!chosen || busy}
                        onClick={launch}
                        className="molten-btn cursor-pointer rounded px-3 py-1.5 text-xs disabled:cursor-default disabled:opacity-50"
                    >
                        {busy ? (
                            <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin mr-1.5 text-[10px]" />
                        ) : null}
                        {chosen ? `Build ${chosen.title || chosen.id}` : "Choose a build"}
                        <MoltenWave />
                    </button>
                    {facts?.fetcherror ? (
                        <div className="text-[11px] text-warning">
                            Fetching failed: building the last fetched trunk.
                        </div>
                    ) : null}
                    {error ? <div className="text-xs text-error">{error}</div> : null}
                </MenuPopover>
            ) : null}
        </div>
    );
}
