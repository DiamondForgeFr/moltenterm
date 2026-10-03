// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The "Project" part of the workspace editor (FR-MC-001): the linked folder, or a "Link a project" action, and the
// offer to show the project's logo as the workspace icon; then the folder the workspace works in (FR-SHELL-009).

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { WorkspaceIcon } from "./workspace-icon";
import {
    checkPathInside,
    effectiveWorkspaceFolder,
    pathBaseName,
    readWorkspaceFolder,
    readWorkspaceProject,
} from "./workspace-project";
import {
    chooseMoltentermPath,
    findProjectLogos,
    linkWorkspaceProject,
    ProjectFacts,
    readProjectFacts,
    setWorkspaceFolder,
    setWorkspaceLogo,
    unlinkWorkspaceProject,
} from "./workspace-project-store";

const LinkButtonClass =
    "cursor-pointer rounded px-2 py-1 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary";

function ProjectStatusLine({ facts }: { facts: ProjectFacts }) {
    if (facts == null) {
        return null;
    }
    if (!facts.exists) {
        return <div className="text-xs text-warning">The folder no longer exists: link the project again.</div>;
    }
    return (
        <div className="text-xs text-muted">
            {facts.hasPipeline ? "Pipeline ready" : "No pipeline yet"}
            {facts.harness ? ` · ${facts.harness}` : ""}
        </div>
    );
}

function LogoChoices({ ws, logos, chosen, dir }: { ws: Workspace; logos: string[]; chosen: string; dir: string }) {
    const pickOther = () =>
        fireAndForget(async () => {
            const file = await chooseMoltentermPath({ kind: "image", title: "Workspace icon", defaultPath: dir });
            if (file) {
                await setWorkspaceLogo(ws.oid, file);
            }
        });
    const choices = chosen && !logos.includes(chosen) ? [chosen, ...logos] : logos;
    return (
        <div className="mt-2">
            <div className="mb-1 text-xs text-secondary">
                {chosen ? "Workspace icon" : "Use an image of the project as the workspace icon?"}
            </div>
            <div className="flex flex-wrap items-center gap-1">
                <button
                    type="button"
                    title="Keep the workspace's icon"
                    aria-pressed={!chosen}
                    onClick={() => fireAndForget(() => setWorkspaceLogo(ws.oid, null))}
                    className={cn(
                        "flex h-8 w-8 cursor-pointer items-center justify-center rounded border text-[15px] hover:bg-hover",
                        !chosen ? "border-accent" : "border-border"
                    )}
                >
                    <WorkspaceIcon icon={ws.icon} color={ws.color} />
                </button>
                {choices.map((logo) => (
                    <button
                        key={logo}
                        type="button"
                        title={logo}
                        aria-pressed={logo === chosen}
                        onClick={() => fireAndForget(() => setWorkspaceLogo(ws.oid, logo))}
                        className={cn(
                            "flex h-8 w-8 cursor-pointer items-center justify-center rounded border text-[18px] hover:bg-hover",
                            logo === chosen ? "border-accent" : "border-border"
                        )}
                    >
                        <WorkspaceIcon icon={ws.icon} color={ws.color} logo={logo} />
                    </button>
                ))}
                <button type="button" onClick={pickOther} className={LinkButtonClass}>
                    Other image…
                </button>
            </div>
        </div>
    );
}

// Where the workspace's new terminals, tabs and file explorer start (FR-SHELL-009).
function WorkspaceFolderLine({ ws }: { ws: Workspace }) {
    const folder = effectiveWorkspaceFolder(ws);
    const stored = readWorkspaceFolder(ws);
    const projectDir = readWorkspaceProject(ws).dir;
    const outsideProject = stored !== "" && projectDir !== "" && !checkPathInside(stored, projectDir);
    const change = () =>
        fireAndForget(async () => {
            const dir = await chooseMoltentermPath({
                kind: "folder",
                title: "Workspace folder",
                defaultPath: folder || projectDir || undefined,
            });
            if (dir) {
                await setWorkspaceFolder(ws.oid, dir);
            }
        });
    return (
        <div className="mt-3">
            <div className="mb-1 text-xs font-semibold tracking-wide text-secondary uppercase">Folder</div>
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <div className={cn("truncate text-sm", folder ? "" : "text-muted")}>
                        {folder ? pathBaseName(folder) || folder : "Not set yet"}
                    </div>
                    <div className="truncate text-xs text-muted" title={folder}>
                        {folder || "Set by the next folder your terminal goes to"}
                    </div>
                </div>
                <button type="button" onClick={change} className={LinkButtonClass}>
                    Change…
                </button>
                {stored ? (
                    <button
                        type="button"
                        title="Forget it: the next folder your terminal goes to is used"
                        onClick={() => fireAndForget(() => setWorkspaceFolder(ws.oid, null))}
                        className={LinkButtonClass}
                    >
                        Reset
                    </button>
                ) : null}
            </div>
            <div className="text-xs text-muted">
                {outsideProject
                    ? "Outside the project: new panels start at its root."
                    : "New terminals, tabs and files start here."}
            </div>
        </div>
    );
}

export function WorkspaceProjectSection({ workspaceId }: { workspaceId: string }) {
    const [ws] = useWaveObjectValue<Workspace>(makeORef("workspace", workspaceId));
    const project = readWorkspaceProject(ws);
    const [facts, setFacts] = useState<ProjectFacts>(null);
    const [logos, setLogos] = useState<string[]>([]);
    const [error, setError] = useState<string>(null);

    useEffect(() => {
        setFacts(null);
        setLogos([]);
        if (project.dir === "") {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const [nextFacts, nextLogos] = await Promise.all([
                readProjectFacts(project.dir),
                findProjectLogos(project.dir),
            ]);
            if (!cancelled) {
                setFacts(nextFacts);
                setLogos(nextLogos);
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
                title: "Link a project",
                defaultPath: project.dir || undefined,
            });
            if (!folder) {
                return;
            }
            try {
                await linkWorkspaceProject(ws, folder);
            } catch (e) {
                setError(`Could not link the project: ${e?.message ?? e}`);
            }
        });
    return (
        <div className="molten-workspace-project mt-2 w-full min-w-0 self-stretch border-t border-border px-1 pt-2 text-left">
            <div className="mb-1 text-xs font-semibold tracking-wide text-secondary uppercase">Project</div>
            {project.dir === "" ? (
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted">Mission Control shows the linked project.</span>
                    <button
                        type="button"
                        onClick={link}
                        className="shrink-0 cursor-pointer rounded bg-accent/80 px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
                    >
                        Link a project…
                    </button>
                </div>
            ) : (
                <>
                    <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">{facts?.name ?? pathBaseName(project.dir)}</div>
                            <div className="truncate text-xs text-muted" title={project.dir}>
                                {project.dir}
                            </div>
                        </div>
                        <button type="button" onClick={link} className={LinkButtonClass}>
                            Change…
                        </button>
                        <button
                            type="button"
                            onClick={() => fireAndForget(() => unlinkWorkspaceProject(ws.oid))}
                            className={LinkButtonClass}
                        >
                            Unlink
                        </button>
                    </div>
                    <ProjectStatusLine facts={facts} />
                    {facts?.exists ? (
                        <LogoChoices ws={ws} logos={logos} chosen={project.logo} dir={project.dir} />
                    ) : null}
                </>
            )}
            {error ? <div className="mt-1 text-xs text-error">{error}</div> : null}
            <WorkspaceFolderLine ws={ws} />
        </div>
    );
}
