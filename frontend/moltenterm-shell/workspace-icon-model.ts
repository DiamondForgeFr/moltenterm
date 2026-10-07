// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Which icon a workspace shows (FR-SHELL-031, DS-SHELL-037), decided in one place for every surface: the image
// imported for it, then its project's logo (FR-MC-001), then its built-in icon and colour. The built-in icon and colour
// stay set underneath, so an image that is removed or fails to show steps down without an error. Kept apart from the
// component so the rules can be tested without the app. pkg/molten/workspaceicon.go mirrors the order.

import { ProjectLogoMetaKey } from "./workspace-project";

// must match the keys in pkg/molten/workspaceicon.go
export const WorkspaceIconMetaKey = "molten:workspaceicon";
export const WorkspaceIconsDirName = "workspace-icons";
// What the picker offers; the type is judged again from the content by wavesrv.
export const WorkspaceIconExtensions = ["png", "jpg", "jpeg", "webp", "svg", "ico"];

// Only names MoltenTerm made (<workspaceid>-<12 hex>.<ext>): a meta value can never point the badge at another file.
const StoredIconNameRegex = /^[A-Za-z0-9-]{1,64}-[0-9a-f]{12}\.(png|jpg|webp|svg|ico)$/;

export type WorkspaceIconKind = "imported" | "logo" | "builtin";

// What a surface needs to draw a workspace's badge; image is the stored file name, logo an absolute path. revision is
// the workspace's version, when the surface reads it live.
export type WorkspaceIconSource = { icon: string; color: string; image: string; logo: string; revision?: number };

export type ResolvedWorkspaceIcon = { kind: WorkspaceIconKind; path: string; icon: string; color: string };

function metaString(meta: Record<string, any>, key: string): string {
    const value = meta?.[key];
    return typeof value === "string" ? value : "";
}

export function checkStoredIconName(name: string): boolean {
    return StoredIconNameRegex.test(name ?? "");
}

export function readWorkspaceIconImage(ws: Workspace): string {
    return metaString(ws?.meta as Record<string, any>, WorkspaceIconMetaKey);
}

export function workspaceIconSource(ws: Workspace): WorkspaceIconSource {
    const meta = ws?.meta as Record<string, any>;
    return {
        icon: ws?.icon ?? "",
        color: ws?.color ?? "",
        image: metaString(meta, WorkspaceIconMetaKey),
        logo: metaString(meta, ProjectLogoMetaKey),
        revision: ws?.version,
    };
}

export function storedIconPath(dataDir: string, name: string): string {
    if (!dataDir || !checkStoredIconName(name)) {
        return "";
    }
    const sep = dataDir.includes("\\") && !dataDir.includes("/") ? "\\" : "/";
    return dataDir.replace(/[/\\]+$/, "") + sep + WorkspaceIconsDirName + sep + name;
}

// failed holds the paths that did not display: each one steps down to the next level.
export function resolveWorkspaceIcon(
    source: WorkspaceIconSource,
    dataDir: string,
    failed: readonly string[] = []
): ResolvedWorkspaceIcon {
    const builtin: ResolvedWorkspaceIcon = {
        kind: "builtin",
        path: "",
        icon: source?.icon ?? "",
        color: source?.color ?? "",
    };
    const imported = storedIconPath(dataDir, source?.image);
    if (imported && !failed.includes(imported)) {
        return { ...builtin, kind: "imported", path: imported };
    }
    const logo = source?.logo ?? "";
    if (logo && !failed.includes(logo)) {
        return { ...builtin, kind: "logo", path: logo };
    }
    return builtin;
}

export function hasImportedIcon(ws: Workspace): boolean {
    return checkStoredIconName(readWorkspaceIconImage(ws));
}

// What a screen reader hears after the icon and colour names.
export function iconKindLabel(kind: WorkspaceIconKind): string {
    if (kind === "imported") {
        return "imported image";
    }
    return kind === "logo" ? "project logo" : "";
}
