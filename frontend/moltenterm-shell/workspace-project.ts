// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace linked to its project (FR-MC-001): the project folder and the optional logo live in the workspace's
// meta. molten writes the same keys (pkg/molten/project.go). Kept apart from the components so the rules can be
// tested without the app.

// must match the keys in pkg/molten/project.go
export const ProjectMetaKey = "molten:project";
export const ProjectLogoMetaKey = "molten:projectlogo";
// The project the logo was last offered for: the offer is made once per link, never again after a "no".
export const ProjectLogoOfferMetaKey = "molten:projectlogooffer";
// The folder the workspace works in (FR-SHELL-009). must match WorkspaceFolderMetaKey in pkg/molten/folder.go
export const WorkspaceFolderMetaKey = "molten:folder";

export const ProjectPipelineFile = ".molten/project.json";
export const ProjectSaaSFoundryFile = ".saasfoundry.json";
export const MaxProjectLogos = 8;

// Where projects usually keep their icon, best first. must match projectLogoCandidates in pkg/molten/project.go
export const LogoCandidatePaths = [
    "icon.svg",
    "icon.png",
    "logo.svg",
    "logo.png",
    "build/icon.png",
    "build/icon.svg",
    "build/icons/icon.png",
    "build/icons/512x512.png",
    "build/icons/256x256.png",
    "build/appicon.png",
    "src-tauri/icons/icon.png",
    "src-tauri/icons/128x128@2x.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    "assets/appicon.png",
    "public/icon.svg",
    "public/icon.png",
    "public/logo.svg",
    "public/logo.png",
    "static/icon.svg",
    "static/icon.png",
    "static/logo.svg",
    "static/logo.png",
    "src/assets/icon.svg",
    "src/assets/icon.png",
    "src/assets/logo.svg",
    "src/assets/logo.png",
    "public/apple-touch-icon.png",
    "public/favicon.svg",
    "public/favicon.png",
    "public/favicon.ico",
    "static/favicon.svg",
    "static/favicon.png",
    "static/favicon.ico",
    "favicon.svg",
    "favicon.png",
    "favicon.ico",
];

export const LogoExtensions = ["svg", "png", "ico", "jpg", "jpeg", "webp", "gif"];

export type WorkspaceProject = { dir: string; logo: string; logoOffer: string };

function metaString(meta: Record<string, any>, key: string): string {
    const value = meta?.[key];
    return typeof value === "string" ? value : "";
}

export function readWorkspaceProject(ws: Workspace): WorkspaceProject {
    const meta = ws?.meta as Record<string, any>;
    return {
        dir: metaString(meta, ProjectMetaKey),
        logo: metaString(meta, ProjectLogoMetaKey),
        logoOffer: metaString(meta, ProjectLogoOfferMetaKey),
    };
}

// The folder the workspace's terminal last went to, as stored.
export function readWorkspaceFolder(ws: Workspace): string {
    return metaString(ws?.meta as Record<string, any>, WorkspaceFolderMetaKey);
}

function trimTrailingSeparators(path: string): string {
    const trimmed = (path ?? "").replace(/[/\\]+$/, "");
    return trimmed === "" && (path ?? "") !== "" ? path.slice(0, 1) : trimmed;
}

export function checkPathInside(path: string, dir: string): boolean {
    if (!path || !dir) {
        return false;
    }
    const p = trimTrailingSeparators(path);
    const d = trimTrailingSeparators(dir);
    if (p === d) {
        return true;
    }
    // Only a root keeps its separator once trimmed.
    if (/[/\\]$/.test(d)) {
        return p.startsWith(d);
    }
    return p.startsWith(d + "/") || p.startsWith(d + "\\");
}

export function checkAbsolutePath(path: string): boolean {
    return /^(\/|[A-Za-z]:[/\\]|\\\\)/.test(path ?? "");
}

// Where new blocks of the workspace start (same rule as WorkspaceFolder in pkg/molten/folder.go): a linked workspace
// stays inside its project, so a folder outside it stands for the project's root.
export function effectiveWorkspaceFolder(ws: Workspace): string {
    const folder = readWorkspaceFolder(ws);
    const project = readWorkspaceProject(ws).dir;
    if (project !== "" && !checkPathInside(folder, project)) {
        return project;
    }
    return folder;
}

// The folder to store when the focused terminal goes to cwd, or null to leave the workspace's folder as it is.
export function nextWorkspaceFolder(stored: string, projectDir: string, cwd: string): string {
    if (!checkAbsolutePath(cwd)) {
        return null;
    }
    const folder = trimTrailingSeparators(cwd);
    if (folder === stored || (projectDir && !checkPathInside(folder, projectDir))) {
        return null;
    }
    return folder;
}

export function pathBaseName(path: string): string {
    const parts = (path ?? "").split(/[/\\]/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? "";
}

export function pathParent(path: string): string {
    const trimmed = (path ?? "").replace(/[/\\]+$/, "");
    const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (index < 0) {
        return "";
    }
    return index === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, index);
}

function jsonName(value: any, key: string): string {
    const name = value?.[key];
    return typeof name === "string" ? name : "";
}

// The same order as molten: the pipeline's name, then SaaSFoundryAI's project name, package.json, the folder name.
export function projectName(dir: string, pipeline: any, saasfoundry: any, pkg: any): string {
    return (
        jsonName(pipeline, "name") || jsonName(saasfoundry, "projectName") || jsonName(pkg, "name") || pathBaseName(dir)
    );
}

export function isLogoFile(path: string): boolean {
    const match = /\.([a-z0-9]+)$/i.exec(path ?? "");
    return match != null && LogoExtensions.includes(match[1].toLowerCase());
}

// Joins a path relative to the project; null when it would leave the project (a README pointing to "../x.png").
export function projectFilePath(dir: string, rel: string): string {
    const parts: string[] = [];
    for (const part of (rel ?? "").split(/[/\\]/)) {
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            return null;
        }
        parts.push(part);
    }
    if (parts.length === 0) {
        return null;
    }
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    return dir.replace(/[/\\]+$/, "") + sep + parts.join(sep);
}

const ReadmeImageRegex = /<img[^>]*\ssrc=["']([^"']+)["']|!\[[^\]]*\]\(\s*<?([^)\s>]+)/gi;

// The README's first image when it is a file of the project (not a badge or a web URL).
export function readmeFirstImage(readme: string): string {
    for (const match of (readme ?? "").matchAll(ReadmeImageRegex)) {
        const src = match[1] ?? match[2] ?? "";
        if (src.includes("://") || src.startsWith("data:")) {
            continue;
        }
        return src.split("#")[0].replace(/^\.\//, "");
    }
    return "";
}

// The relative paths to probe, in order; the README's image comes last.
export function logoProbeOrder(readmeImage: string): string[] {
    const order = [...LogoCandidatePaths];
    if (readmeImage && !order.includes(readmeImage)) {
        order.push(readmeImage);
    }
    return order.filter(isLogoFile);
}

// Offered once per linked project, only when the workspace still shows its own icon and an image was found.
export function shouldOfferLogo(project: WorkspaceProject, logos: string[]): boolean {
    return project.dir !== "" && project.logo === "" && project.logoOffer !== project.dir && (logos?.length ?? 0) > 0;
}

// The meta written when a workspace is linked: a logo chosen for another project would stand for the wrong one.
export function linkUpdate(current: WorkspaceProject, dir: string): Record<string, any> {
    const update: Record<string, any> = { [ProjectMetaKey]: dir };
    if (current.dir !== dir) {
        update[ProjectLogoMetaKey] = null;
    }
    return update;
}

export function unlinkUpdate(): Record<string, any> {
    return { [ProjectMetaKey]: null, [ProjectLogoMetaKey]: null, [ProjectLogoOfferMetaKey]: null };
}

export function logoUrl(endpoint: string, path: string): string {
    return endpoint + "/wave/stream-local-file?path=" + encodeURIComponent(path);
}
