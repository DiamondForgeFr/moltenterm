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
    pathBaseName,
    pathParent,
    projectFilePath,
    ProjectLogoMetaKey,
    ProjectLogoOfferMetaKey,
    ProjectPipelineFile,
    ProjectSaaSFoundryFile,
    readmeFirstImage,
    readWorkspaceProject,
    shouldOfferLogo,
    unlinkUpdate,
} from "./workspace-project";

const MaxGitRootDepth = 40;
const MaxReadmeBytes = 256 * 1024;

export type ProjectFacts = { exists: boolean; hasPipeline: boolean; harness: string };

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

export async function readProjectFacts(dir: string): Promise<ProjectFacts> {
    const [folder, pipeline, saasfoundry] = await Promise.all([
        statPath(dir),
        statPath(projectFilePath(dir, ProjectPipelineFile)),
        statPath(projectFilePath(dir, ProjectSaaSFoundryFile)),
    ]);
    return {
        exists: folder?.isdir === true,
        hasPipeline: pipeline != null && !pipeline.isdir,
        harness: saasfoundry != null ? "SaaSFoundryAI" : "",
    };
}

async function readReadme(dir: string): Promise<string> {
    for (const name of ["README.md", "readme.md", "Readme.md"]) {
        const info = await statPath(projectFilePath(dir, name));
        if (info == null || info.isdir) {
            continue;
        }
        try {
            const data = await RpcApi.FileReadCommand(TabRpcClient, {
                info: { path: info.path },
                at: { offset: 0, size: MaxReadmeBytes },
            });
            return data?.data64 ? base64ToString(data.data64) : "";
        } catch {
            return "";
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
    addMoltentermNotification({
        source: "moltenterm",
        kind: "info",
        title: `Use ${pathBaseName(project.dir)}'s logo for this workspace?`,
        message: "Right-click the workspace in the rail, then Edit workspace…, to pick an image or keep the icon.",
        workspaceid: ws.oid,
    });
}
