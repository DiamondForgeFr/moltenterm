// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Project and Folder sections of the workspace edit sheet (FR-SHELL-030, DS-SHELL-036): the linked folder, or a
// "Link a project" action; the folder the workspace works in (FR-SHELL-009). The project's images are offered by the
// sheet's Logo field, in its Project part (#1280). The sheet gives each its heading.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { contextShownEmblem, contextShownName } from "./contexts/context-model";
import { checkWorkspaceFolder, useContextFolder, useContextOf } from "./contexts/context-store";
import { RibbonFace } from "./contexts/ribbon";
import { ribbonPaint } from "./contexts/ribbon-model";
import { useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";
import { FolderOutsideDialog } from "./workspace-folder-outside";
import {
    canResetWorkspaceFolder,
    isProjectOutsideBound,
    pathBaseName,
    readWorkspaceProject,
    WorkspaceFolderView,
    workspaceFolderView,
} from "./workspace-project";
import {
    chooseMoltentermPath,
    linkWorkspaceProject,
    ProjectFacts,
    readProjectFacts,
    setWorkspaceFolder,
    unlinkWorkspaceProject,
} from "./workspace-project-store";

const LinkButtonClass = "molten-btn-secondary cursor-pointer rounded-6 px-2 py-1 text-12";
const GhostClass =
    "cursor-pointer rounded-6 px-2 py-1 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary";

// A linked project that lies outside the folder bounding its workspace is only marked (#2518).
export function OutsideFolderMark() {
    const t = useT();
    return (
        <span className="shrink-0 text-11 text-warning" data-testid="project-outside-folder">
            {t("workspace.edit.outsideFolder")}
        </span>
    );
}

function ProjectStatusLine({ facts }: { facts: ProjectFacts }) {
    const t = useT();
    if (facts == null) {
        return null;
    }
    if (!facts.exists) {
        return <div className="text-12 text-warning">{t("workspace.project.folderGone")}</div>;
    }
    return (
        <div className="text-12 text-muted">
            {t(facts.hasPipeline ? "workspace.project.pipelineReady" : "workspace.project.noPipeline")}
            {facts.harness ? ` · ${facts.harness}` : ""}
        </div>
    );
}

// The line under the folder: where its panels stay and start, and in which context (#2518).
function FolderSentence({ ws, view }: { ws: Workspace; view: WorkspaceFolderView }) {
    const t = useT();
    const context = useContextOf(ws);
    if (view.kind === "none") {
        return <>{t("workspace.project.setByNext")}</>;
    }
    if (view.kind === "followed") {
        return <>{t(view.outsideProject ? "workspace.project.outsideProject" : "workspace.project.startsHere")}</>;
    }
    const { paint, ink } = ribbonPaint(ws?.color ?? "");
    return (
        <>
            {t("workspace.project.boundsHere")}{" "}
            <span className="inline-flex max-w-full align-middle" data-testid="folder-context-ribbon">
                <RibbonFace
                    emblem={contextShownEmblem(context)}
                    name={contextShownName(context, t)}
                    paint={paint}
                    ink={ink}
                    shape={context?.shape}
                />
            </span>
        </>
    );
}

// The workspace's folder (FR-SHELL-009, #2518): one line holding the folder, Change… and Reset, and under it what the
// folder does. A folder chosen for the workspace bounds its panels, and so does its context's while none is chosen
// ("Inherited from the context", no Reset). A folder outside the context's asks first, and is never refused.
export function WorkspaceFolderLine({ ws }: { ws: Workspace }) {
    const t = useT();
    const contextFolder = useContextFolder(ws);
    const context = useContextOf(ws);
    const view = workspaceFolderView(ws, contextFolder);
    const projectDir = readWorkspaceProject(ws).dir;
    const [outside, setOutside] = useState<string>(null);
    const shown = view.kind === "none" ? "" : view.folder;
    const choose = () =>
        fireAndForget(async () => {
            const dir = await chooseMoltentermPath({
                kind: "folder",
                title: t("workspace.project.folderDialog"),
                defaultPath: shown || projectDir || undefined,
            });
            if (!dir) {
                return;
            }
            const check = await checkWorkspaceFolder(ws, dir);
            if (check.outside) {
                setOutside(dir);
                return;
            }
            await setWorkspaceFolder(ws.oid, dir, true);
        });
    const useOutside = () => {
        const dir = outside;
        setOutside(null);
        fireAndForget(() => setWorkspaceFolder(ws.oid, dir, true));
    };
    const chooseAnother = () => {
        setOutside(null);
        choose();
    };
    return (
        <div className="min-w-0" data-folder-kind={view.kind}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <div
                    className={cn(
                        "min-w-0 flex-1 basis-40 truncate text-12 leading-5",
                        view.kind === "chosen" || view.kind === "followed" ? "font-mono" : "",
                        view.kind === "none" || view.kind === "inherited" ? "text-secondary" : ""
                    )}
                    title={shown}
                    data-testid="workspace-folder"
                >
                    {view.kind === "inherited"
                        ? t("workspace.project.inheritedFrom", { folder: view.folder })
                        : shown || t("workspace.project.notSetYet")}
                </div>
                <button type="button" onClick={choose} className={LinkButtonClass}>
                    {t("workspace.project.change")}
                </button>
                {canResetWorkspaceFolder(view) ? (
                    <button
                        type="button"
                        title={t("workspace.project.forgetFolder")}
                        onClick={() => fireAndForget(() => setWorkspaceFolder(ws.oid, null))}
                        className={GhostClass}
                    >
                        {t("workspace.project.reset")}
                    </button>
                ) : null}
            </div>
            <div className="mt-1.5 text-11 leading-5 text-muted">
                <FolderSentence ws={ws} view={view} />
            </div>
            {outside != null ? (
                <FolderOutsideDialog
                    contextName={contextShownName(context, t)}
                    contextFolder={contextFolder}
                    onUse={useOutside}
                    onChooseAnother={chooseAnother}
                    onCancel={() => setOutside(null)}
                />
            ) : null}
        </div>
    );
}

export function WorkspaceProjectBlock({ ws }: { ws: Workspace }) {
    const t = useT();
    const contextFolder = useContextFolder(ws);
    const project = readWorkspaceProject(ws);
    const outsideFolder = isProjectOutsideBound(project.dir, ws, contextFolder);
    const [facts, setFacts] = useState<ProjectFacts>(null);
    const [error, setError] = useState<string>(null);

    useEffect(() => {
        setFacts(null);
        if (project.dir === "") {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const nextFacts = await readProjectFacts(project.dir);
            if (!cancelled) {
                setFacts(nextFacts);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [project.dir]);

    if (ws == null) {
        return null;
    }
    const link = () =>
        fireAndForget(async () => {
            setError(null);
            const folder = await chooseMoltentermPath({
                kind: "folder",
                title: t("workspace.project.linkDialog"),
                defaultPath: project.dir || undefined,
            });
            if (!folder) {
                return;
            }
            try {
                await linkWorkspaceProject(ws, folder);
            } catch (e) {
                setError(t("workspace.project.linkFailed", { error: e?.message ?? String(e) }));
            }
        });
    return (
        <div className="molten-workspace-project min-w-0 text-left">
            {project.dir === "" ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 text-12 text-muted">{t("workspace.project.mcShowsLinked")}</span>
                    <button
                        type="button"
                        onClick={link}
                        className="molten-btn shrink-0 cursor-pointer rounded-6 px-2 py-1 text-12"
                    >
                        {t("workspace.project.linkProject")}
                        <MoltenWave />
                    </button>
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <div className="min-w-0 flex-1 basis-40">
                            <div className="flex min-w-0 items-center gap-1.5 text-13 leading-5">
                                <span className="truncate">{facts?.name ?? pathBaseName(project.dir)}</span>
                                {outsideFolder ? <OutsideFolderMark /> : null}
                            </div>
                            <div className="truncate text-12 text-muted" title={project.dir}>
                                {project.dir}
                            </div>
                        </div>
                        <button type="button" onClick={link} className={LinkButtonClass}>
                            {t("workspace.project.change")}
                        </button>
                        <button
                            type="button"
                            onClick={() => fireAndForget(() => unlinkWorkspaceProject(ws.oid))}
                            className={LinkButtonClass}
                        >
                            {t("workspace.project.unlink")}
                        </button>
                    </div>
                    <ProjectStatusLine facts={facts} />
                </>
            )}
            {error ? (
                <div role="alert" className="mt-1 text-12 text-danger">
                    {error}
                </div>
            ) : null}
        </div>
    );
}
