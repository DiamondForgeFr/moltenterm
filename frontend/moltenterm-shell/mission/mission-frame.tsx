// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What both Mission Control panels share (FR-MC-002): they follow the active workspace's project (FR-MC-001), show the
// action that fixes a missing piece (link a project, create the pipeline), and frame the collector's snapshot with
// its age and a refresh button.

import { atoms, createBlock } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { MoltenWave } from "../molten-button";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { chooseMoltentermPath, linkWorkspaceProject, ProjectFacts, readProjectFacts } from "../workspace-project-store";
import { useMissionSnapshot } from "./mission-client";
import { formatAge, MissionSnapshot, PipelineInvocations, PipelineReport, pipelineStage } from "./mission-model";

export type ActiveProject = { workspace: Workspace; dir: string; facts: ProjectFacts };

export function useActiveProject(): ActiveProject {
    const workspace = useAtomValue(atoms.workspace);
    const dir = readWorkspaceProject(workspace).dir;
    const [facts, setFacts] = useState<ProjectFacts>(null);
    useEffect(() => {
        setFacts(null);
        if (dir === "") {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const next = await readProjectFacts(dir);
            if (!cancelled) {
                setFacts(next);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir]);
    return { workspace, dir, facts };
}

function linkProject(workspace: Workspace) {
    fireAndForget(async () => {
        const folder = await chooseMoltentermPath({ kind: "folder", title: "Link a project" });
        if (folder) {
            await linkWorkspaceProject(workspace, folder);
        }
    });
}

function EmptyState({
    icon,
    title,
    text,
    children,
}: {
    icon: string;
    title: string;
    text: string;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex h-full w-full items-center justify-center p-6">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
                <i className={cn("fa fa-solid text-3xl text-muted", `fa-${icon}`)} />
                <div className="text-base font-semibold">{title}</div>
                <div className="text-sm text-secondary">{text}</div>
                {children}
            </div>
        </div>
    );
}

const AccentButton = "molten-btn cursor-pointer rounded px-3 py-1.5 text-sm";
const PlainButton =
    "cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary";

export function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () =>
        fireAndForget(async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    return (
        <button type="button" onClick={copy} className={PlainButton}>
            <i className={cn("fa fa-solid mr-1.5", copied ? "fa-check" : "fa-copy")} />
            {copied ? "Copied" : label}
        </button>
    );
}

function openProjectTerminal(dir: string) {
    fireAndForget(() => createBlock({ meta: { view: "term", controller: "shell", "cmd:cwd": dir } }));
}

// A project without a valid pipeline still shows its history; the banner says how the user's agent connects it.
export function PipelineBanner({ dir, report }: { dir: string; report: PipelineReport }) {
    const stage = pipelineStage(report);
    if (stage === "loading" || stage === "valid") {
        return null;
    }
    const invalid = stage === "invalid";
    return (
        <div
            className={cn(
                "flex items-start gap-3 rounded border px-3 py-2",
                invalid ? "border-warning/40 bg-warning/10" : "border-accent/40 bg-accent/10"
            )}
        >
            <i
                className={cn(
                    "fa fa-solid mt-0.5",
                    invalid ? "fa-triangle-exclamation text-warning" : "fa-wand-magic-sparkles text-accent"
                )}
            />
            <div className="min-w-0 flex-1 text-xs">
                <div className="font-semibold text-primary">
                    {invalid ? "The pipeline has problems" : "Connect the pipeline"}
                </div>
                {invalid ? (
                    <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-secondary">
                        {report.errors.slice(0, 5).map((e) => (
                            <li key={e}>• {e}</li>
                        ))}
                        {report.errors.length > 5 ? <li>… and {report.errors.length - 5} more</li> : null}
                    </ul>
                ) : (
                    <div className="mt-0.5 text-secondary">
                        Mission Control runs this project's own CI, builds and releases once they are described in
                        .molten/project.json. Your coding agent connects what the project already has and creates what
                        is missing, following the project's workflow: open a terminal in the project, start your agent
                        and type the command below.
                    </div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                    {PipelineInvocations.map((i) => (
                        <span key={i.invocation}>
                            {i.agent}: <code className="text-secondary">{i.invocation}</code>
                        </span>
                    ))}
                </div>
                <div className="mt-1 text-[11px] text-muted">
                    Command not found in your agent? Run <code>molten agent install &lt;agent&gt;</code> once.
                    {invalid ? " Check again with molten project validate." : ""}
                </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
                <CopyButton text="/molten-pipeline" label="Copy /molten-pipeline" />
                <button type="button" onClick={() => openProjectTerminal(dir)} className={PlainButton}>
                    <i className="fa fa-solid fa-terminal mr-1.5" />
                    Open a terminal here
                </button>
            </div>
        </div>
    );
}

export function MissionHeader({
    project,
    snapshot,
    onRefresh,
    children,
}: {
    project: ActiveProject;
    snapshot: MissionSnapshot;
    onRefresh: () => void;
    children?: React.ReactNode;
}) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
    }, []);
    const name = project.facts?.name ?? pathBaseName(project.dir);
    const at = Math.max(snapshot?.gitat ?? 0, snapshot?.githubat ?? 0);
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-xs text-secondary" title={project.dir}>
                    {name}
                    {snapshot?.git ? ` · ${snapshot.git.trunk}` : ""}
                </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
                {children}
                <span className="text-[11px] text-muted">
                    {snapshot?.refreshing ? "refreshing…" : `updated ${formatAge(at, now)}`}
                </span>
                <button
                    type="button"
                    aria-label="Refresh"
                    title="Refresh (fetches from the remote)"
                    onClick={onRefresh}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary hover:bg-hover hover:text-primary"
                >
                    <i className={cn("fa fa-solid fa-rotate text-[11px]", snapshot?.refreshing && "fa-spin")} />
                </button>
            </div>
        </div>
    );
}

// Renders the panel once a project is linked and readable; otherwise the state that explains why, with its fix.
export function MissionFrame({
    title,
    children,
}: {
    title: string;
    children: (props: { project: ActiveProject; snapshot: MissionSnapshot; refresh: () => void }) => React.ReactNode;
}) {
    const project = useActiveProject();
    const { snapshot, error, refresh } = useMissionSnapshot(project.dir);
    if (project.workspace == null) {
        return null;
    }
    if (project.dir === "") {
        return (
            <EmptyState
                icon="link"
                title="Link this workspace to its project"
                text={`${title} shows the project of the active workspace. Link a folder here, or run molten project link in a terminal of the project.`}
            >
                <button type="button" className={AccentButton} onClick={() => linkProject(project.workspace)}>
                    Link a project…
                    <MoltenWave />
                </button>
            </EmptyState>
        );
    }
    if (snapshot?.missing || project.facts?.exists === false) {
        return (
            <EmptyState
                icon="folder-open"
                title="The project's folder is gone"
                text={`${project.dir} no longer exists. Link the workspace to the project's new place.`}
            >
                <button type="button" className={AccentButton} onClick={() => linkProject(project.workspace)}>
                    Link a project…
                    <MoltenWave />
                </button>
            </EmptyState>
        );
    }
    if (error && snapshot == null) {
        return <EmptyState icon="triangle-exclamation" title="Mission Control could not answer" text={error} />;
    }
    if (snapshot?.giterror && snapshot.git == null) {
        return (
            <EmptyState
                icon="code-branch"
                title="Not a git repository"
                text={`Mission Control reads the project's history from git: ${snapshot.giterror}`}
            />
        );
    }
    return (
        <div className="@container flex h-full w-full flex-col overflow-hidden tabular-nums">
            {children({ project, snapshot, refresh })}
        </div>
    );
}
