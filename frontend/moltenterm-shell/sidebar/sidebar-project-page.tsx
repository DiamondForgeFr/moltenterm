// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The add-a-project page of the sidebar (FR-SHELL-087): it takes the sidebar's page with three fields, the project's
// type, its folder and the branch it follows. Opened on a project, it edits it, and takes it out of the workspace
// (nothing is written in the project's folder).

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { workspaceShownName } from "../workspace-default-name";
import { chooseMoltentermPath } from "../workspace-project-store";
import { ProjectPage, SidebarModel } from "./sidebar-store";
import {
    ProjectDraft,
    projectDraftProblem,
    projectLabel,
    projectTypeSuggestions,
    readProjects,
} from "./workspace-projects";
import { addWorkspaceProject, editWorkspaceProject, removeWorkspaceProject } from "./workspace-projects-store";

const FieldClass =
    "mt-1 w-full min-w-0 rounded-4 border border-white/15 bg-black/25 px-2 py-1.5 text-12 text-primary outline-none placeholder:text-muted focus:border-white/40";
const LabelClass = "flex flex-col text-11 text-secondary";
const SecondaryButton =
    "cursor-pointer rounded-6 border border-white/15 px-3 py-1.5 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary";

// Keys typed in the form stay in it: the window's shortcuts (⌘S, ⌥1…) would act behind it.
function keepKeys(e: React.KeyboardEvent) {
    e.stopPropagation();
}

export function ProjectPageView({ page }: { page: ProjectPage }) {
    const t = useT();
    const model = SidebarModel.getInstance();
    const ws = useAtomValue(atoms.workspace);
    const typeRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        typeRef.current?.focus();
    }, []);
    useEffect(() => {
        if (ws?.oid && page.workspaceId && ws.oid !== page.workspaceId) {
            model.closeProjectPage();
        }
    }, [ws?.oid, page.workspaceId]);
    const editing = page.id != null;
    const projects = readProjects(ws);
    const edited = editing ? projects.find((p) => p.id === page.id) : null;
    const name = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const draft = page.draft;
    const change = (next: Partial<ProjectDraft>) => {
        setError(null);
        model.updateProjectDraft(next);
    };
    const chooseFolder = () =>
        fireAndForget(async () => {
            const folder = await chooseMoltentermPath({
                kind: "folder",
                title: t("sidebar.project.folderDialog"),
                defaultPath: draft.dir || undefined,
            });
            if (folder) {
                change({ dir: folder });
            }
        });
    const run = (action: () => Promise<void>) => {
        if (busy) {
            return;
        }
        setBusy(true);
        setError(null);
        fireAndForget(async () => {
            try {
                await action();
                model.closeProjectPage();
            } catch (e) {
                setError(t("sidebar.project.failed", { error: e?.message ?? String(e) }));
            } finally {
                setBusy(false);
            }
        });
    };
    const submit = () => {
        const problem = projectDraftProblem(ws, draft, page.id);
        if (problem != null) {
            setError(t(problem));
            return;
        }
        run(() => (editing ? editWorkspaceProject(page.id, draft) : addWorkspaceProject(draft)));
    };
    const title = editing
        ? t("sidebar.project.editTitle", { project: projectLabel(edited) })
        : t("sidebar.project.addTitle", { name });
    return (
        <form
            className="flex flex-col gap-3 px-1 pt-1.5 pb-2"
            aria-label={title}
            data-testid="sidebar-project-page"
            onSubmit={(e) => {
                e.preventDefault();
                submit();
            }}
            onKeyDown={(e) => {
                keepKeys(e);
                if (e.key === "Escape") {
                    e.preventDefault();
                    model.closeProjectPage();
                }
            }}
        >
            <div className="flex items-center gap-2">
                <h3 className="m-0 min-w-0 flex-1 truncate text-13 font-semibold text-primary" title={title}>
                    {title}
                </h3>
                <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                    aria-label={t("sidebar.project.cancel")}
                    title={t("sidebar.project.cancel")}
                    onClick={() => model.closeProjectPage()}
                >
                    <i className="fa fa-solid fa-xmark text-11" aria-hidden />
                </button>
            </div>
            {editing ? null : <p className="m-0 text-11 leading-4 text-muted">{t("sidebar.project.lede")}</p>}
            <label className={LabelClass}>
                {t("sidebar.project.type")}
                <input
                    ref={typeRef}
                    className={FieldClass}
                    value={draft.type}
                    list={listId}
                    placeholder={t("sidebar.project.typePlaceholder")}
                    data-testid="sidebar-project-type-input"
                    onChange={(e) => change({ type: e.target.value })}
                />
                <datalist id={listId}>
                    {projectTypeSuggestions(t("sidebar.project.typeSuggestions")).map((s) => (
                        <option key={s} value={s} />
                    ))}
                </datalist>
            </label>
            <label className={LabelClass}>
                {t("sidebar.project.folder")}
                <span className="mt-1 flex min-w-0 items-center gap-1">
                    <input
                        className={cn(FieldClass, "mt-0 flex-1 font-mono text-11")}
                        value={draft.dir}
                        placeholder={t("sidebar.project.folderPlaceholder")}
                        spellCheck={false}
                        data-testid="sidebar-project-folder"
                        onChange={(e) => change({ dir: e.target.value })}
                    />
                    <button
                        type="button"
                        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                        aria-label={t("sidebar.project.chooseFolder")}
                        title={t("sidebar.project.chooseFolder")}
                        onClick={chooseFolder}
                    >
                        <i className="fa fa-solid fa-folder-open text-11" aria-hidden />
                    </button>
                </span>
            </label>
            <label className={LabelClass}>
                {t("sidebar.project.branch")}
                <input
                    className={cn(FieldClass, "font-mono text-11")}
                    value={draft.branch}
                    placeholder={t("sidebar.project.branchPlaceholder")}
                    spellCheck={false}
                    data-testid="sidebar-project-branch"
                    onChange={(e) => change({ branch: e.target.value })}
                />
            </label>
            {error ? (
                <p className="m-0 text-11 text-danger" role="alert" data-testid="sidebar-project-error">
                    {error}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                    type="submit"
                    disabled={busy}
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12"
                    data-testid="sidebar-project-submit"
                >
                    {editing ? t("sidebar.project.save") : t("sidebar.project.add")}
                    <MoltenWave />
                </button>
                <button type="button" className={SecondaryButton} onClick={() => model.closeProjectPage()}>
                    {t("sidebar.project.cancel")}
                </button>
            </div>
            {editing && projects.length > 1 ? (
                <button
                    type="button"
                    disabled={busy}
                    className="cursor-pointer self-start rounded-6 px-1 py-1 text-11 text-muted transition-colors duration-120 ease-mt hover:text-danger"
                    title={t("sidebar.project.removeTitle")}
                    data-testid="sidebar-project-remove"
                    onClick={() => run(() => removeWorkspaceProject(page.id))}
                >
                    {t("sidebar.project.remove")}
                </button>
            ) : null}
        </form>
    );
}
