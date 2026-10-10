// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What both Mission Control panels share (FR-MC-002): they follow the active workspace's project (FR-MC-001), show the
// action that fixes a missing piece (link a project, create the pipeline), and frame the collector's snapshot with
// its age and a refresh button.

import { atoms, createBlock } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { DialogFrame, useEscape } from "../dialog-frame";
import { EmptyState, EmptyStateDetails } from "../empty-state";
import { MoltenWave } from "../molten-button";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { chooseMoltentermPath, linkWorkspaceProject, ProjectFacts, readProjectFacts } from "../workspace-project-store";
import { FolderEntry, gitProblem, sortFolderEntries } from "./git-problem";
import { missionGitInit, useMissionSnapshot } from "./mission-client";
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

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary";

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
                "flex items-start gap-3 rounded-4 border px-3 py-2",
                invalid ? "border-warning/40 bg-warning/10" : "border-accent/40 bg-accent/10"
            )}
        >
            <i
                className={cn(
                    "fa fa-solid mt-0.5",
                    invalid ? "fa-triangle-exclamation text-warning" : "fa-wand-magic-sparkles text-accent"
                )}
            />
            <div className="min-w-0 flex-1 text-12">
                <div className="font-semibold text-primary">
                    {invalid ? "The pipeline has problems" : "Connect the pipeline"}
                </div>
                {invalid ? (
                    <ul className="mt-1 flex flex-col gap-0.5 font-mono text-11 text-secondary">
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
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-muted">
                    {PipelineInvocations.map((i) => (
                        <span key={i.invocation}>
                            {i.agent}: <code className="text-secondary">{i.invocation}</code>
                        </span>
                    ))}
                </div>
                <div className="mt-1 text-11 text-muted">
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
                <span className="truncate text-12 text-secondary" title={project.dir}>
                    {name}
                    {snapshot?.git ? ` · ${snapshot.git.trunk}` : ""}
                </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
                {children}
                <span className="text-11 text-muted">
                    {snapshot?.refreshing ? "refreshing…" : `updated ${formatAge(at, now)}`}
                </span>
                <button
                    type="button"
                    aria-label="Refresh"
                    title="Refresh (fetches from the remote)"
                    onClick={onRefresh}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                >
                    <i
                        className={cn("fa fa-solid fa-rotate text-11", snapshot?.refreshing && "fa-spin mt-step-spin")}
                    />
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
                hint={`${title} shows the project of the active workspace. Link a folder here, or run molten project link in a terminal of the project.`}
                primary={{ label: "Link a project…", onClick: () => linkProject(project.workspace) }}
            />
        );
    }
    if (snapshot?.missing || project.facts?.exists === false) {
        return (
            <EmptyState
                icon="folder-open"
                title="The project's folder is gone"
                hint={`${project.dir} no longer exists. Link the workspace to the project's new place.`}
                primary={{ label: "Link a project…", onClick: () => linkProject(project.workspace) }}
            />
        );
    }
    if (error && snapshot == null) {
        return (
            <EmptyState
                icon="triangle-exclamation"
                title="Mission Control could not answer"
                hint="MoltenTerm could not read this project. Try again in a moment."
                primary={{ label: "Try again", onClick: refresh }}
                details={error}
            />
        );
    }
    if (snapshot?.giterror && snapshot.git == null) {
        return <GitProblemState project={project} gitError={snapshot.giterror} refresh={refresh} />;
    }
    return (
        <div className="@container flex h-full w-full flex-col overflow-hidden tabular-nums">
            {children({ project, snapshot, refresh })}
        </div>
    );
}

const FolderGlanceMax = 12;

// The reduced project view of a folder without git history: what is in it, so the user recognises the folder.
function FolderGlance({ dir }: { dir: string }) {
    const [entries, setEntries] = useState<FolderEntry[]>(null);
    useEffect(() => {
        setEntries(null);
        let cancelled = false;
        fireAndForget(async () => {
            let list: FolderEntry[] = [];
            try {
                const infos = await RpcApi.FileListCommand(TabRpcClient, { path: dir });
                list = (infos ?? []).map((info) => ({ name: info.name, isDir: !!info.isdir }));
            } catch {
                list = [];
            }
            if (!cancelled) {
                setEntries(sortFolderEntries(list));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir]);
    const shown = (entries ?? []).slice(0, FolderGlanceMax);
    const more = (entries?.length ?? 0) - shown.length;
    return (
        <div
            className="mt-4 w-full rounded-6 border border-line bg-surface-2 p-3 text-left"
            data-testid="mission-folder-glance"
        >
            <div className="flex min-w-0 items-center gap-2">
                <i className="fa fa-solid fa-folder text-icon-14 text-muted" aria-hidden />
                <span className="truncate text-12 font-medium text-primary">{pathBaseName(dir)}</span>
            </div>
            <div className="mt-0.5 truncate font-mono text-11 text-muted" title={dir}>
                {dir}
            </div>
            {entries == null ? null : entries.length === 0 ? (
                <div className="mt-2 text-12 text-muted">This folder is empty.</div>
            ) : (
                <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" aria-label="Files in the folder">
                    {shown.map((e) => (
                        <li key={e.name} className="flex min-w-0 items-center gap-1.5 text-12 text-secondary">
                            <i
                                className={cn(
                                    "fa fa-solid fa-fw text-11 text-muted",
                                    e.isDir ? "fa-folder" : "fa-file"
                                )}
                                aria-hidden
                            />
                            <span className="truncate" title={e.name}>
                                {e.name}
                            </span>
                        </li>
                    ))}
                    {more > 0 ? <li className="text-12 text-muted">and {more} more</li> : null}
                </ul>
            )}
        </div>
    );
}

function GitInitDialog({ dir, onCancel, onDone }: { dir: string; onCancel: () => void; onDone: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEscape(!busy, onCancel);
    useEffect(() => {
        cancelRef.current?.focus();
    }, []);
    const confirm = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                await missionGitInit(dir);
                onDone();
            } catch (e) {
                setError(String(e?.message ?? e));
                setBusy(false);
            }
        });
    return (
        <DialogFrame
            role="molten-git-init"
            title="Initialize git here?"
            subtitle={dir}
            trapFocus
            buttons={
                <>
                    <button
                        ref={cancelRef}
                        type="button"
                        className="molten-btn-secondary h-row cursor-pointer rounded-6 px-3 text-12"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="molten-btn h-row cursor-pointer rounded-6 px-3 text-12 font-medium"
                        onClick={confirm}
                        disabled={busy}
                        aria-busy={busy}
                        data-testid="mission-git-init-confirm"
                    >
                        {busy ? "Initializing…" : "Initialize git"}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <p className="text-12 leading-[18px] text-secondary">
                MoltenTerm runs git init in this folder. It adds an empty repository (a .git folder): your files stay as
                they are, nothing is committed.
            </p>
            {error ? (
                <>
                    <p className="text-12 text-danger" role="alert">
                        Git could not create the repository.
                    </p>
                    <EmptyStateDetails text={error} />
                </>
            ) : null}
        </DialogFrame>
    );
}

// A linked folder whose history git cannot read (FR-SHELL-053-AC2): the plain reason and its fix, git's own output
// only under Details.
function GitProblemState({
    project,
    gitError,
    refresh,
}: {
    project: ActiveProject;
    gitError: string;
    refresh: () => void;
}) {
    const [confirming, setConfirming] = useState(false);
    const [initialized, setInitialized] = useState(false);
    useEffect(() => {
        setInitialized(false);
    }, [gitError]);
    const problem = gitProblem(gitError);
    if (problem === "notrepo") {
        return (
            <>
                <EmptyState
                    icon="code-branch"
                    title="This folder is not a git repository"
                    hint="Mission Control follows a project through its git history. Initialize git here or choose another folder."
                    primary={{
                        label: "Initialize git here",
                        busy: initialized,
                        busyLabel: "Reading the history…",
                        onClick: () => setConfirming(true),
                        testId: "mission-git-init",
                    }}
                    secondary={{
                        label: "Choose another folder",
                        onClick: () => linkProject(project.workspace),
                        testId: "mission-choose-folder",
                    }}
                    details={gitError}
                    testId="mission-not-git"
                >
                    <FolderGlance dir={project.dir} />
                </EmptyState>
                {confirming ? (
                    <GitInitDialog
                        dir={project.dir}
                        onCancel={() => setConfirming(false)}
                        onDone={() => {
                            setConfirming(false);
                            setInitialized(true);
                            refresh();
                        }}
                    />
                ) : null}
            </>
        );
    }
    if (problem === "nogit") {
        return (
            <EmptyState
                icon="code-branch"
                title="Git is not installed"
                hint="Mission Control reads the project's history with git. Install git, then try again."
                primary={{ label: "Try again", onClick: refresh }}
                details={gitError}
            />
        );
    }
    return (
        <EmptyState
            icon="code-branch"
            title="Git could not read this project"
            hint="The history of this folder could not be read. Try again, or choose another folder."
            primary={{ label: "Try again", onClick: refresh }}
            secondary={{ label: "Choose another folder", onClick: () => linkProject(project.workspace) }}
            details={gitError}
        />
    );
}
