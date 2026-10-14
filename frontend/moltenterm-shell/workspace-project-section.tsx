// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project and Folder sections of the workspace edit sheet (FR-SHELL-030, DS-SHELL-036): the linked folder, or a
// "Link a project" action; the folder the workspace works in (FR-SHELL-009). The project's images are offered by the
// sheet's Icon field (DS-SHELL-101). The sheet gives each its heading.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { useT } from "./i18n/i18n";
import { MoltenWave } from "./molten-button";
import {
    checkPathInside,
    effectiveWorkspaceFolder,
    pathBaseName,
    readWorkspaceFolder,
    readWorkspaceProject,
} from "./workspace-project";
import {
    chooseMoltentermPath,
    linkWorkspaceProject,
    ProjectFacts,
    readProjectFacts,
    setWorkspaceFolder,
    unlinkWorkspaceProject,
} from "./workspace-project-store";

const LinkButtonClass =
    "cursor-pointer rounded-6 px-2 py-1 text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary";

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

// Where the workspace's new terminals, tabs and file explorer start (FR-SHELL-009).
export function WorkspaceFolderLine({ ws }: { ws: Workspace }) {
    const t = useT();
    const folder = effectiveWorkspaceFolder(ws);
    const stored = readWorkspaceFolder(ws);
    const projectDir = readWorkspaceProject(ws).dir;
    const outsideProject = stored !== "" && projectDir !== "" && !checkPathInside(stored, projectDir);
    const change = () =>
        fireAndForget(async () => {
            const dir = await chooseMoltentermPath({
                kind: "folder",
                title: t("workspace.project.folderDialog"),
                defaultPath: folder || projectDir || undefined,
            });
            if (dir) {
                await setWorkspaceFolder(ws.oid, dir);
            }
        });
    return (
        <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <div className="min-w-0 flex-1 basis-40">
                    <div className={cn("truncate text-13 leading-5", folder ? "" : "text-muted")}>
                        {folder ? pathBaseName(folder) || folder : t("workspace.project.notSetYet")}
                    </div>
                    <div className="truncate text-12 text-muted" title={folder}>
                        {folder || t("workspace.project.setByNext")}
                    </div>
                </div>
                <button type="button" onClick={change} className={LinkButtonClass}>
                    {t("workspace.project.change")}
                </button>
                {stored ? (
                    <button
                        type="button"
                        title={t("workspace.project.forgetFolder")}
                        onClick={() => fireAndForget(() => setWorkspaceFolder(ws.oid, null))}
                        className={LinkButtonClass}
                    >
                        {t("workspace.project.reset")}
                    </button>
                ) : null}
            </div>
            <div className="mt-1 text-12 text-muted">
                {t(outsideProject ? "workspace.project.outsideProject" : "workspace.project.startsHere")}
            </div>
        </div>
    );
}

export function WorkspaceProjectBlock({ ws }: { ws: Workspace }) {
    const t = useT();
    const project = readWorkspaceProject(ws);
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
                            <div className="truncate text-13 leading-5">{facts?.name ?? pathBaseName(project.dir)}</div>
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
                <div role="alert" className="mt-1 text-12 text-error">
                    {error}
                </div>
            ) : null}
        </div>
    );
}
