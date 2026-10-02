// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What both Mission Control panels share (FR-MC-002): they follow the active workspace's project (FR-MC-001), show the
// action that fixes a missing piece (link a project, create the pipeline), and frame the collector's snapshot with
// its age and a refresh button.

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { chooseMoltentermPath, linkWorkspaceProject, ProjectFacts, readProjectFacts } from "../workspace-project-store";
import { useMissionSnapshot } from "./mission-client";
import { formatAge, MissionSnapshot, pipelineRequest } from "./mission-model";

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
        const read = () =>
            fireAndForget(async () => {
                const next = await readProjectFacts(dir);
                if (!cancelled) {
                    setFacts(next);
                }
            });
        read();
        // The user's agent writes the pipeline file while the panel is open: notice it without a restart.
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                read();
            }
        }, 15000);
        return () => {
            cancelled = true;
            clearInterval(timer);
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

const AccentButton =
    "cursor-pointer rounded bg-accent/80 px-3 py-1.5 text-sm text-primary transition-colors hover:bg-accent";
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

// A project without a pipeline still shows its history; the banner says how to get the rest.
export function PipelineBanner({ dir, facts }: { dir: string; facts: ProjectFacts }) {
    if (facts == null || facts.hasPipeline || !facts.exists) {
        return null;
    }
    const request = pipelineRequest(dir);
    return (
        <div className="flex items-start gap-3 rounded border border-accent/40 bg-accent/10 px-3 py-2">
            <i className="fa fa-solid fa-wand-magic-sparkles mt-0.5 text-accent" />
            <div className="min-w-0 flex-1 text-xs">
                <div className="font-semibold text-primary">Create the pipeline</div>
                <div className="mt-0.5 text-secondary">
                    This project has no pipeline yet (local CI, builds, releases). Ask your coding agent to create it
                    with this request; it follows the project's own workflow and writes .molten/project.json last.
                </div>
                <div className="mt-1.5 line-clamp-2 font-mono text-[11px] text-muted" title={request}>
                    {request}
                </div>
            </div>
            <CopyButton text={request} label="Copy the request" />
        </div>
    );
}

export function MissionHeader({
    title,
    project,
    snapshot,
    onRefresh,
    children,
}: {
    title: string;
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
                <span className="text-sm font-semibold">{title}</span>
                <span className="truncate text-xs text-muted" title={project.dir}>
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
        <div className="@container flex h-full w-full flex-col overflow-hidden">
            {children({ project, snapshot, refresh })}
        </div>
    );
}
