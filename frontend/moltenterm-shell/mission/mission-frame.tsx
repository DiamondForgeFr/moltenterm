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
import { t, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
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
        const folder = await chooseMoltentermPath({ kind: "folder", title: t("mc.frame.linkProjectTitle") });
        if (folder) {
            await linkWorkspaceProject(workspace, folder);
        }
    });
}

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary";

export function CopyButton({ text, label }: { text: string; label: string }) {
    const t = useT();
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
            {copied ? t("mc.frame.copied") : label}
        </button>
    );
}

function openProjectTerminal(dir: string) {
    fireAndForget(() => createBlock({ meta: { view: "term", controller: "shell", "cmd:cwd": dir } }));
}

// A project without a valid pipeline still shows its history; the banner says how the user's agent connects it.
export function PipelineBanner({ dir, report }: { dir: string; report: PipelineReport }) {
    const t = useT();
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
                    {invalid ? t("mc.frame.pipelineProblems") : t("mc.frame.connectPipeline")}
                </div>
                {invalid ? (
                    <ul className="mt-1 flex flex-col gap-0.5 font-mono text-11 text-secondary">
                        {report.errors.slice(0, 5).map((e) => (
                            <li key={e}>• {e}</li>
                        ))}
                        {report.errors.length > 5 ? (
                            <li>… {t("mc.releaseMenu.andMore", { count: report.errors.length - 5 })}</li>
                        ) : null}
                    </ul>
                ) : (
                    <div className="mt-0.5 text-secondary">{t("mc.frame.connectBody")}</div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-muted">
                    {PipelineInvocations.map((i) => (
                        <span key={i.invocation}>
                            {i.agent}: <code className="text-secondary">{i.invocation}</code>
                        </span>
                    ))}
                </div>
                <div className="mt-1 text-11 text-muted">
                    {t("mc.frame.notFoundBefore")} <code>molten agent install &lt;agent&gt;</code>{" "}
                    {t("mc.frame.notFoundAfter")}
                    {invalid ? " " + t("mc.frame.checkAgain") : ""}
                </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
                <CopyButton
                    text="/molten-pipeline"
                    label={t("mc.frame.copyCommand", { command: "/molten-pipeline" })}
                />
                <button type="button" onClick={() => openProjectTerminal(dir)} className={PlainButton}>
                    <i className="fa fa-solid fa-terminal mr-1.5" />
                    {t("mc.frame.openTerminal")}
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
    const t = useT();
    const [now, setNow] = useState(Date.now());
    const panelId = usePanelBlockId();
    useEffect(() => {
        return everyInPanel(panelId, whileShown(30000), () => setNow(Date.now()), "clock");
    }, [panelId]);
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
                    {snapshot?.refreshing
                        ? t("mc.frame.refreshing")
                        : t("mc.frame.updated", { when: formatAge(at, now) })}
                </span>
                <button
                    type="button"
                    aria-label={t("mc.frame.refresh")}
                    title={t("mc.frame.refreshTitle")}
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
    const t = useT();
    const project = useActiveProject();
    const { snapshot, error, refresh } = useMissionSnapshot(project.dir);
    if (project.workspace == null) {
        return null;
    }
    if (project.dir === "") {
        return (
            <EmptyState
                icon="link"
                title={t("mc.frame.linkTitle")}
                hint={t("mc.frame.linkHint", { title })}
                primary={{ label: t("mc.frame.linkButton"), onClick: () => linkProject(project.workspace) }}
            />
        );
    }
    if (snapshot?.missing || project.facts?.exists === false) {
        return (
            <EmptyState
                icon="folder-open"
                title={t("mc.frame.goneTitle")}
                hint={t("mc.frame.goneHint", { dir: project.dir })}
                primary={{ label: t("mc.frame.linkButton"), onClick: () => linkProject(project.workspace) }}
            />
        );
    }
    if (error && snapshot == null) {
        return (
            <EmptyState
                icon="triangle-exclamation"
                title={t("mc.frame.errorTitle")}
                hint={t("mc.frame.errorHint")}
                primary={{ label: t("mc.frame.tryAgain"), onClick: refresh }}
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
    const t = useT();
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
                <div className="mt-2 text-12 text-muted">{t("mc.frame.folderEmpty")}</div>
            ) : (
                <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" aria-label={t("mc.frame.filesInFolder")}>
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
                    {more > 0 ? (
                        <li className="text-12 text-muted">{t("mc.releaseMenu.andMore", { count: more })}</li>
                    ) : null}
                </ul>
            )}
        </div>
    );
}

function GitInitDialog({ dir, onCancel, onDone }: { dir: string; onCancel: () => void; onDone: () => void }) {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEscape(!busy, onCancel);
    // After the frame: the pane the click came from takes the focus back on mouseup, which would leave the dialog
    // without it.
    useEffect(() => {
        const timer = setTimeout(() => cancelRef.current?.focus(), 0);
        return () => clearTimeout(timer);
    }, []);
    const confirm = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                await missionGitInit(dir);
                onDone();
            } catch (e) {
                setError(serverErrorText(e));
                setBusy(false);
            }
        });
    return (
        <DialogFrame
            role="molten-git-init"
            title={t("mc.frame.gitInitTitle")}
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
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn h-row cursor-pointer rounded-6 px-3 text-12 font-medium"
                        onClick={confirm}
                        disabled={busy}
                        aria-busy={busy}
                        data-testid="mission-git-init-confirm"
                    >
                        {busy ? t("mc.frame.initializing") : t("mc.frame.initGit")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <p className="text-12 leading-[18px] text-secondary">{t("mc.frame.gitInitBody")}</p>
            {error ? (
                <>
                    <p className="text-12 text-danger" role="alert">
                        {t("mc.frame.gitInitFailed")}
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
    const t = useT();
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
                    title={t("mc.frame.notRepoTitle")}
                    hint={t("mc.frame.notRepoHint")}
                    primary={{
                        label: t("mc.frame.initGitHere"),
                        busy: initialized,
                        busyLabel: t("mc.frame.readingHistory"),
                        onClick: () => setConfirming(true),
                        testId: "mission-git-init",
                    }}
                    secondary={{
                        label: t("mc.frame.chooseFolder"),
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
                title={t("mc.frame.noGitTitle")}
                hint={t("mc.frame.noGitHint")}
                primary={{ label: t("mc.frame.tryAgain"), onClick: refresh }}
                details={gitError}
            />
        );
    }
    return (
        <EmptyState
            icon="code-branch"
            title={t("mc.frame.gitErrorTitle")}
            hint={t("mc.frame.gitErrorHint")}
            primary={{ label: t("mc.frame.tryAgain"), onClick: refresh }}
            secondary={{ label: t("mc.frame.chooseFolder"), onClick: () => linkProject(project.workspace) }}
            details={gitError}
        />
    );
}
