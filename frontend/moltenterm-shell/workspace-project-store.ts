// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Reads a linked project and writes the link (FR-MC-001). Files are read through wavesrv, like molten does; nothing
// is ever written in the project.

import { getApi } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { MoltentermChoosePathOpts } from "@/util/moltenterm-dialogs";
import { base64ToString } from "@/util/util";
import { addMoltentermNotification } from "./notifications-store";
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
    shouldOfferLogo,
    unlinkUpdate,
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

// The closest folder at or above dir holding a ".git" entry, as molten does; the folder itself without one.
export async function resolveProjectDir(dir: string): Promise<string> {
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
    return dir;
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

export async function setWorkspaceLogo(workspaceId: string, logo: string): Promise<void> {
    await setWorkspaceMeta(workspaceId, { [ProjectLogoMetaKey]: logo || null });
}

// Once per linked project: when it has images and the workspace still shows its own icon, a notification points to
// the editor. Recorded before the notification, so a second window or a quick relink never offers it twice.
export async function offerProjectLogo(ws: Workspace): Promise<void> {
    const project = readWorkspaceProject(ws);
    if (project.dir === "" || project.logo !== "" || project.logoOffer === project.dir) {
        return;
    }
    const logos = await findProjectLogos(project.dir);
    if (!shouldOfferLogo(project, logos)) {
        return;
    }
    await setWorkspaceMeta(ws.oid, { [ProjectLogoOfferMetaKey]: project.dir });
    const facts = await readProjectFacts(project.dir);
    addMoltentermNotification({
        source: "moltenterm",
        kind: "info",
        title: `Use ${facts.name}'s logo for this workspace?`,
        message: "Right-click the workspace in the rail, then Edit workspace…, to pick an image or keep the icon.",
        workspaceid: ws.oid,
    });
}
