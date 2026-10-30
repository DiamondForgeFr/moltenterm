// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project sheet (FR-SHELL-105): the one home of what belongs to a project of the workspace, its repository and
// folder, its type and followed branch, its logo, its pipeline and CI, and its coding agent. Every block is "For this
// project". The workspace sheet's Projects block and the Project panel open it; it goes back to the workspace sheet.
// A change is saved as soon as it is made, as in the workspace sheet.

import { atoms } from "@/app/store/global";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useId, useState } from "react";
import {
    CodingAgentIds,
    CodingAgentModel,
    codingAgentName,
    rememberedProjectAgent,
    rememberProjectAgent,
} from "./coding-agent/coding-agent";
import { DialogFrame } from "./dialog-frame";
import { t as translateNow, useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";
import { openMoltentermView } from "./open-view";
import { MoltentermProjectView } from "./project/project-model";
import { currentProjectId, projectLabel, readProjects, WorkspaceProjectEntry } from "./sidebar/workspace-projects";
import { projectDraftProblem, projectTypeSuggestions } from "./sidebar/workspace-projects-edit";
import { editWorkspaceProject, removeWorkspaceProject } from "./sidebar/workspace-projects-edit-store";
import { ToggleGroup, ToggleOption } from "./suite/suite";
import { projectSheetBlocks } from "./workspace-edit-model";
import { LogoField, ResultLine, SheetSection, useProjectLogos } from "./workspace-edit-sheet";
import { pathBaseName, projectLogoOf, readWorkspaceProject } from "./workspace-project";
import { WorkspaceProjectBlock } from "./workspace-project-section";
import {
    chooseMoltentermPath,
    linkWorkspaceProject,
    ProjectFacts,
    readProjectFacts,
    setProjectLogo,
    unlinkWorkspaceProject,
} from "./workspace-project-store";

const FieldLabelClass = "mb-1 flex text-12 text-secondary";
const InputClass =
    "w-full min-w-0 rounded-4 border border-border bg-transparent px-2 py-1.5 text-13 leading-5 text-primary outline-none placeholder:text-muted focus:border-accent";
const SecondaryButtonClass =
    "shrink-0 cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-60";
const FocusRingClass =
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)";

// The project the sheet shows: the asked one, else the current one.
export function sheetProject(ws: Workspace, projectId: string): WorkspaceProjectEntry {
    const projects = readProjects(ws);
    const id = projectId && projects.some((p) => p.id === projectId) ? projectId : currentProjectId(ws);
    return projects.find((p) => p.id === id) ?? null;
}

// What leaves the project: Unlink for the workspace's only project, Remove from the workspace when there are others
// (FR-SHELL-087: nothing is written in the project's folder either way).
export function projectExit(projectCount: number): "unlink" | "remove" {
    return projectCount > 1 ? "remove" : "unlink";
}

function useProjectFacts(dir: string): ProjectFacts {
    const [facts, setFacts] = useState<ProjectFacts>(null);
    useEffect(() => {
        setFacts(null);
        if (!dir) {
            return;
        }
        let live = true;
        fireAndForget(async () => {
            const next = await readProjectFacts(dir);
            if (live) {
                setFacts(next);
            }
        });
        return () => {
            live = false;
        };
    }, [dir]);
    return facts;
}

function RepositoryBlock({
    ws,
    project,
    facts,
    projectCount,
    isCurrent,
}: {
    ws: Workspace;
    project: WorkspaceProjectEntry;
    facts: ProjectFacts;
    projectCount: number;
    isCurrent: boolean;
}) {
    const t = useT();
    const [error, setError] = useState<string>(null);
    const exit = projectExit(projectCount);
    const run = (fn: () => Promise<void>) =>
        fireAndForget(async () => {
            setError(null);
            try {
                await fn();
            } catch (e) {
                setError(t("workspace.project.linkFailed", { error: e?.message ?? String(e) }));
            }
        });
    // The current project's folder is the workspace's link (molten:project): it goes through the link, which finds
    // the repository's root and keeps the recent folders.
    const change = () =>
        run(async () => {
            const folder = await chooseMoltentermPath({
                kind: "folder",
                title: translateNow("workspace.project.linkDialog"),
                defaultPath: project.dir || undefined,
            });
            if (!folder) {
                return;
            }
            if (isCurrent) {
                await linkWorkspaceProject(ws, folder);
                return;
            }
            await editWorkspaceProject(project.id, { type: project.type, dir: folder, branch: project.branch }, ws);
        });
    const leave = () =>
        run(() => (exit === "remove" ? removeWorkspaceProject(project.id, ws) : unlinkWorkspaceProject(ws.oid)));
    return (
        <SheetSection title={t("projectSheet.repository")} concept="git" scope="project" block="repository">
            <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <div className="min-w-0 flex-1 basis-40">
                        <div className={cn("truncate text-13 leading-5", project.dir ? "" : "text-muted")}>
                            {project.dir ? (facts?.name ?? pathBaseName(project.dir)) : t("projectSheet.noFolder")}
                        </div>
                        {project.dir ? (
                            <div className="truncate font-mono text-11 text-muted" title={project.dir}>
                                {project.dir}
                            </div>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        onClick={change}
                        data-action="project-folder"
                        className={cn(SecondaryButtonClass, FocusRingClass)}
                    >
                        {t("workspace.project.change")}
                    </button>
                    <button
                        type="button"
                        onClick={leave}
                        data-action={`project-${exit}`}
                        title={exit === "remove" ? t("sidebar.project.removeTitle") : undefined}
                        className={cn(SecondaryButtonClass, FocusRingClass)}
                    >
                        {exit === "remove" ? t("sidebar.project.remove") : t("workspace.project.unlink")}
                    </button>
                </div>
                {facts != null && !facts.exists ? (
                    <div className="text-12 text-warning">{t("workspace.project.folderGone")}</div>
                ) : null}
                {error ? (
                    <div role="alert" className="text-12 text-danger">
                        {error}
                    </div>
                ) : null}
            </div>
        </SheetSection>
    );
}

// Type and followed branch: saved when the field is left or on Enter, as the sidebar's form did.
function DetailsBlock({ ws, project }: { ws: Workspace; project: WorkspaceProjectEntry }) {
    const t = useT();
    const typeId = useId();
    const branchId = useId();
    const listId = useId();
    const [type, setType] = useState<string>(null);
    const [branch, setBranch] = useState<string>(null);
    const [error, setError] = useState<string>(null);
    const shownType = type ?? project.type;
    const shownBranch = branch ?? project.branch;
    const commit = () => {
        if (type == null && branch == null) {
            return;
        }
        const draft = { type: shownType, dir: project.dir, branch: shownBranch };
        const problem = projectDraftProblem(ws, draft, project.id);
        if (problem != null) {
            setError(t(problem));
            return;
        }
        setError(null);
        fireAndForget(async () => {
            await editWorkspaceProject(project.id, draft, ws);
            setType(null);
            setBranch(null);
        });
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            commit();
        }
    };
    return (
        <SheetSection title={t("projectSheet.details")} concept="project" scope="project" block="details">
            <div className="flex min-w-0 flex-col gap-3">
                <div className="min-w-0" data-field="type">
                    <label htmlFor={typeId} className={FieldLabelClass}>
                        {t("sidebar.project.type")}
                    </label>
                    <input
                        id={typeId}
                        type="text"
                        list={listId}
                        value={shownType}
                        placeholder={t("sidebar.project.typePlaceholder")}
                        onChange={(e) => setType(e.target.value)}
                        onBlur={commit}
                        onKeyDown={onKeyDown}
                        className={InputClass}
                    />
                    <datalist id={listId}>
                        {projectTypeSuggestions(t("sidebar.project.typeSuggestions")).map((s) => (
                            <option key={s} value={s} />
                        ))}
                    </datalist>
                </div>
                <div className="min-w-0" data-field="branch">
                    <label htmlFor={branchId} className={FieldLabelClass}>
                        {t("sidebar.project.branch")}
                    </label>
                    <input
                        id={branchId}
                        type="text"
                        spellCheck={false}
                        value={shownBranch}
                        placeholder={t("sidebar.project.branchPlaceholder")}
                        onChange={(e) => setBranch(e.target.value)}
                        onBlur={commit}
                        onKeyDown={onKeyDown}
                        className={cn(InputClass, "font-mono text-12")}
                    />
                </div>
                {error ? (
                    <div role="alert" className="text-12 text-danger">
                        {error}
                    </div>
                ) : null}
            </div>
        </SheetSection>
    );
}

// The project's logo, chosen here only (FR-SHELL-105). The workspace's Identity decides whether its icon shows it.
function LogoBlock({ ws, project }: { ws: Workspace; project: WorkspaceProjectEntry }) {
    const t = useT();
    const found = useProjectLogos(project.dir);
    const linked = readWorkspaceProject(ws);
    const current = projectLogoOf(linked, project.dir, found);
    const inUse = linked.logo !== "";
    const [result, setResult] = useState<{ ok: boolean; text: string }>(null);
    const choose = (logo: string) =>
        fireAndForget(async () => {
            await setProjectLogo(ws, logo);
            setResult({ ok: true, text: translateNow("workspace.edit.using", { name: pathBaseName(logo) }) });
        });
    return (
        <SheetSection title={t("workspace.edit.logo")} concept="identity" scope="project" block="logo">
            <div className="flex min-w-0 flex-col gap-1.5">
                <LogoField ws={ws} logos={found} current={current} onLogo={choose} />
                <div className="text-12 text-muted" data-role="logo-use">
                    {t(inUse ? "projectSheet.logoInUse" : "projectSheet.logoNotInUse")}
                </div>
                {result ? <ResultLine result={result} role="logo-result" /> : null}
            </div>
        </SheetSection>
    );
}

function PipelineBlock({
    facts,
    isCurrent,
    onClose,
}: {
    facts: ProjectFacts;
    isCurrent: boolean;
    onClose: () => void;
}) {
    const t = useT();
    const windowWs = useAtomValue(atoms.workspace);
    const status =
        facts == null || !facts.exists
            ? null
            : t(facts.hasPipeline ? "workspace.project.pipelineReady" : "workspace.project.noPipeline");
    const openPanel = () => {
        onClose();
        fireAndForget(() => openMoltentermView(MoltentermProjectView));
    };
    return (
        <SheetSection title={t("projectSheet.pipeline")} concept="ci" scope="project" block="pipeline">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1 basis-48 text-12 text-muted" data-role="pipeline-status">
                    {status ?? t("projectSheet.pipelineUnknown")}
                    {facts?.harness ? ` · ${facts.harness}` : ""}
                </div>
                {isCurrent && windowWs != null ? (
                    <button
                        type="button"
                        onClick={openPanel}
                        data-action="open-project-panel"
                        className={cn(SecondaryButtonClass, FocusRingClass)}
                    >
                        {t("projectSheet.openPanel")}
                    </button>
                ) : null}
            </div>
        </SheetSection>
    );
}

const DefaultAgent = "default";

// The same value as the Agent option of the panels that start an agent (#845): this project's choice, or the app's
// default.
function AgentBlock({ dir }: { dir: string }) {
    const t = useT();
    const model = CodingAgentModel.getInstance();
    const choices = useAtomValue(model.choicesAtom);
    const [chosen, setChosen] = useState<string>(() => rememberedProjectAgent(dir) ?? DefaultAgent);
    useEffect(() => {
        model.refresh(dir);
    }, [dir]);
    const choice = choices[dir]?.choice;
    const fallback = choice?.global || choice?.order;
    const installed = new Set((choice?.agents ?? []).filter((a) => a.installed).map((a) => a.id));
    const options: ToggleOption<string>[] = [
        {
            value: DefaultAgent,
            label: fallback
                ? t("projectSheet.agentDefault", { agent: codingAgentName(fallback) })
                : t("projectSheet.agentDefaultNone"),
        },
        ...CodingAgentIds.map((id) => ({ value: id, label: codingAgentName(id) })),
    ];
    const select = (value: string) => {
        setChosen(value);
        fireAndForget(() => rememberProjectAgent(dir, value === DefaultAgent ? undefined : value));
    };
    const missing = chosen !== DefaultAgent && choice?.agents != null && !installed.has(chosen);
    return (
        <SheetSection title={t("projectSheet.agent")} concept="agent" scope="project" block="agent">
            <div className="flex min-w-0 flex-col gap-1.5">
                <ToggleGroup<string>
                    label={t("projectSheet.agent")}
                    options={options}
                    selected={chosen}
                    onSelect={select}
                />
                <div className="text-12 text-muted" data-role="agent-hint">
                    {missing
                        ? t("codingAgent.missing", { agent: codingAgentName(chosen) })
                        : t("projectSheet.agentHint")}
                </div>
            </div>
        </SheetSection>
    );
}

export function ProjectSheet({
    workspaceId,
    projectId,
    onBack,
    onClose,
}: {
    workspaceId: string;
    projectId?: string;
    onBack: () => void;
    onClose: () => void;
}) {
    const t = useT();
    const [ws] = useWaveObjectValue<Workspace>(makeORef("workspace", workspaceId));
    const project = sheetProject(ws, projectId);
    const facts = useProjectFacts(project?.dir ?? "");
    if (ws == null) {
        return null;
    }
    const projects = readProjects(ws);
    const isCurrent = project != null && project.id === currentProjectId(ws);
    const blocks = projectSheetBlocks(!!project?.dir);
    return (
        <DialogFrame
            role="project-sheet"
            onEscape={onClose}
            title={t("projectSheet.title")}
            subtitle={project ? projectLabel(project) : undefined}
            widthClass="w-fit min-w-[min(420px,calc(100vw-32px))] max-w-[min(560px,calc(100vw-32px))]"
            trapFocus
            suite
            onBackdrop={onClose}
            buttons={
                <>
                    <button
                        type="button"
                        onClick={onBack}
                        data-action="back-to-workspace"
                        className={cn(SecondaryButtonClass, FocusRingClass, "mr-auto")}
                    >
                        {t("projectSheet.back")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-4 py-1.5 text-12"
                        onClick={onClose}
                    >
                        {t("workspace.edit.done")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            {project == null ? (
                <SheetSection title={t("projectSheet.repository")} concept="git" scope="project" block="repository">
                    <WorkspaceProjectBlock ws={ws} />
                </SheetSection>
            ) : (
                <>
                    <RepositoryBlock
                        ws={ws}
                        project={project}
                        facts={facts}
                        projectCount={projects.length}
                        isCurrent={isCurrent}
                    />
                    <DetailsBlock key={project.id} ws={ws} project={project} />
                    {blocks.includes("logo") ? <LogoBlock ws={ws} project={project} /> : null}
                    {blocks.includes("pipeline") ? (
                        <PipelineBlock facts={facts} isCurrent={isCurrent} onClose={onClose} />
                    ) : null}
                    {blocks.includes("agent") ? <AgentBlock dir={project.dir} /> : null}
                </>
            )}
        </DialogFrame>
    );
}
