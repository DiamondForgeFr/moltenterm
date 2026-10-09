// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace's badge, as every surface draws it (FR-SHELL-031, DS-SHELL-037): the imported image, the project's logo
// (FR-MC-001) or its Font Awesome icon in its colour, resolved by workspace-icon-model.ts. The Font Awesome icon stays
// set on the workspace: Wave needs it, and it comes back when an image cannot be shown.

import { getApi } from "@/app/store/global";
import { getWebServerEndpoint } from "@/util/endpoints";
import { cn, makeIconClass } from "@/util/util";
import { useState } from "react";
import { resolveWorkspaceIcon, WorkspaceIconSource } from "./workspace-icon-model";
import { logoUrl } from "./workspace-project";

// The rail item's box and glyph size, shared with the edit sheet's preview so it shows the badge at its real size.
export const RailBadgeClass = "relative flex h-9 w-9 items-center justify-center rounded-4 text-icon-16";

// Images fill more of the badge than a glyph does, square and cropped to cover, never stretched (FR-SHELL-031 AC5):
// 24 px with a 4 px radius in the 36 px rail badge, in proportion elsewhere.
export const WorkspaceImageClass = "inline-block h-[1.4em] w-[1.4em] shrink-0 rounded-4 object-cover";

let dataDir: string = null;

// Read once: wavesrv and the renderer share the data folder for the whole run.
function getDataDir(): string {
    if (dataDir == null) {
        try {
            dataDir = getApi()?.getDataDir?.() ?? "";
        } catch {
            dataDir = "";
        }
    }
    return dataDir;
}

type FailedImages = { revision: number; paths: string[] };

export function WorkspaceIcon({ source, className }: { source: WorkspaceIconSource; className?: string }) {
    // The paths that failed to display: the badge steps down one level for each, with no error. A new revision of the
    // workspace (an image imported again under the same name, after its file went missing) tries them again.
    const [failed, setFailed] = useState<FailedImages>({ revision: source?.revision, paths: [] });
    const failedPaths = failed.revision === source?.revision ? failed.paths : [];
    const resolved = resolveWorkspaceIcon(source, getDataDir(), failedPaths);
    if (resolved.kind !== "builtin") {
        return (
            <img
                key={resolved.path}
                src={logoUrl(getWebServerEndpoint(), resolved.path)}
                alt=""
                draggable={false}
                data-icon-kind={resolved.kind}
                decoding="async"
                onError={() =>
                    setFailed({
                        revision: source?.revision,
                        paths: failedPaths.includes(resolved.path) ? failedPaths : [...failedPaths, resolved.path],
                    })
                }
                className={cn(WorkspaceImageClass, className)}
            />
        );
    }
    // The workspace's colour at its glyph tone (tokens.css), readable on every surface whatever the colour.
    return (
        <i
            className={cn(makeIconClass(resolved.icon, false), resolved.color && "molten-glyph-tone", className)}
            style={resolved.color ? ({ "--mt-glyph-color": resolved.color } as React.CSSProperties) : undefined}
            data-icon-kind="builtin"
        />
    );
}

// A badge for a folder that is not a workspace (a project's logo, or a folder glyph).
export function folderIconSource(logo: string): WorkspaceIconSource {
    return { icon: "folder", color: "", image: "", logo: logo ?? "" };
}
