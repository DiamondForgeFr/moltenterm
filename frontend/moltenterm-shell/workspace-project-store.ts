// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reads a linked project and writes the link (FR-MC-001). Files are read through wavesrv, like molten does; nothing
// is ever written in the project.

import { getApi } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MoltentermChoosePathOpts } from "@/util/moltenterm-dialogs";
import { base64ToString } from "@/util/util";
import { ProjectDismissedMetaKey } from "./project-detect";
import {
    linkUpdate,
    logoProbeOrder,
    MaxProjectLogos,
    pathParent,
    projectFilePath,
    ProjectLogoMetaKey,
    ProjectLogoOfferMetaKey,
    projectName,
    ProjectPipelineFile,
    ProjectSaaSFoundryFile,
    readmeFirstImage,
    readWorkspaceProject,
    unlinkUpdate,
    WorkspaceFolderMetaKey,
} from "./workspace-project";

const MaxGitRootDepth = 40;
const MaxReadmeBytes = 256 * 1024;
const MaxJsonBytes = 1024 * 1024;

export type ProjectFacts = { exists: boolean; hasPipeline: boolean; harness: string; name: string };

type MoltentermElectronApi = ElectronApi & {
    moltentermChoosePath: (opts: MoltentermChoosePathOpts) => Promise<string>;
};

export function chooseMoltentermPath(opts: MoltentermChoosePathOpts): Promise<string> {
    return (getApi() as MoltentermElectronApi).moltentermChoosePath(opts);
}

async function statPath(path: string): Promise<FileInfo> {
    try {
        const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path } });
        return info?.notfound ? null : info;
    } catch {
        return null;
    }
}

// The closest folder at or above dir holding a ".git" entry, or "" when dir is in no repository.
export async function findProjectRoot(dir: string): Promise<string> {
    let current = dir.replace(/[/\\]+$/, "") || dir;
    for (let i = 0; i < MaxGitRootDepth && current !== ""; i++) {
        if ((await statPath(projectFilePath(current, ".git") ?? "")) != null) {
            return current;
        }
        const parent = pathParent(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return "";
}

// The closest folder at or above dir holding a ".git" entry, as molten does; the folder itself without one.
export async function resolveProjectDir(dir: string): Promise<string> {
    return (await findProjectRoot(dir)) || dir;
}

async function readText(path: string, maxBytes: number): Promise<string> {
    try {
        const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path }, at: { offset: 0, size: maxBytes } });
        return data?.data64 ? base64ToString(data.data64) : null;
    } catch {
        return null;
    }
}

async function readJson(path: string): Promise<any> {
    const text = await readText(path, MaxJsonBytes);
    if (text == null) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export async function readProjectFacts(dir: string): Promise<ProjectFacts> {
    const [folder, pipeline, saasfoundry, pkg] = await Promise.all([
        statPath(dir),
        readJson(projectFilePath(dir, ProjectPipelineFile)),
        readJson(projectFilePath(dir, ProjectSaaSFoundryFile)),
        readJson(projectFilePath(dir, "package.json")),
    ]);
    return {
        exists: folder?.isdir === true,
        hasPipeline: pipeline != null,
        harness: saasfoundry != null ? "SaaSFoundryAI" : "",
        name: projectName(dir, pipeline, saasfoundry, pkg),
    };
}

async function readReadme(dir: string): Promise<string> {
    for (const name of ["README.md", "readme.md", "Readme.md"]) {
        const text = await readText(projectFilePath(dir, name), MaxReadmeBytes);
        if (text != null) {
            return text;
        }
    }
    return "";
}

// The images that could stand for the project, best first (same rules as molten project logo).
export async function findProjectLogos(dir: string): Promise<string[]> {
    const order = logoProbeOrder(readmeFirstImage(await readReadme(dir)));
    const paths = order.map((rel) => projectFilePath(dir, rel)).filter((p) => p != null);
    const infos = await Promise.all(paths.map((p) => statPath(p)));
    const logos: string[] = [];
    paths.forEach((path, i) => {
        if (infos[i] != null && !infos[i].isdir && !logos.includes(path) && logos.length < MaxProjectLogos) {
            logos.push(path);
        }
    });
    return logos;
}

async function setWorkspaceMeta(workspaceId: string, meta: Record<string, any>): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("workspace", workspaceId), meta: meta as MetaType });
}

export async function linkWorkspaceProject(ws: Workspace, folder: string): Promise<string> {
    const dir = await resolveProjectDir(folder);
    await setWorkspaceMeta(ws.oid, linkUpdate(readWorkspaceProject(ws), dir));
    return dir;
}

export async function unlinkWorkspaceProject(workspaceId: string): Promise<void> {
    await setWorkspaceMeta(workspaceId, unlinkUpdate());
}

// null forgets the folder: the next move of the workspace's terminal sets it again (FR-SHELL-009).
export async function setWorkspaceFolder(workspaceId: string, folder: string): Promise<void> {
    await setWorkspaceMeta(workspaceId, { [WorkspaceFolderMetaKey]: folder || null });
}

export async function setWorkspaceLogo(workspaceId: string, logo: string): Promise<void> {
    await setWorkspaceMeta(workspaceId, { [ProjectLogoMetaKey]: logo || null });
}

// The offer of the project's logo is made once per linked project (#77): remembered whatever the answer.
export async function markLogoOffered(workspaceId: string, dir: string): Promise<void> {
    await setWorkspaceMeta(workspaceId, { [ProjectLogoOfferMetaKey]: dir });
}

export async function dismissProject(workspaceId: string, dismissed: string[]): Promise<void> {
    await setWorkspaceMeta(workspaceId, { [ProjectDismissedMetaKey]: dismissed });
}

export async function renameWorkspace(ws: Workspace, name: string): Promise<void> {
    // Saving a workspace needs an icon and a colour: Wave fills the missing ones.
    await WorkspaceService.UpdateWorkspace(ws.oid, name, ws.icon ?? "", ws.color ?? "", !ws.icon || !ws.color);
}
