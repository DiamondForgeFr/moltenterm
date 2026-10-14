// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace's badge, as every surface draws it (FR-SHELL-031, DS-SHELL-037): the imported image, the project's logo
// (FR-MC-001) or its Font Awesome icon in its colour, resolved by workspace-icon-model.ts. The Font Awesome icon stays
// set on the workspace: Wave needs it, and it comes back when an image cannot be shown.

import { getApi } from "@/app/store/global";
import { getWebServerEndpoint } from "@/util/endpoints";
import { cn, makeIconClass } from "@/util/util";
import { useEffect, useState } from "react";
import { resolveWorkspaceIcon, WorkspaceIconSource } from "./workspace-icon-model";
import { trimmedIconUrl } from "./workspace-icon-trim";
import { logoUrl } from "./workspace-project";

// The rail item's box and glyph size, shared with the edit sheet's preview so it shows the badge at its real size.
export const RailBadgeClass = "relative flex h-9 w-9 items-center justify-center rounded-6 text-icon-16";

// Images fill more of the badge than a glyph does, square and fitted whole, never cropped nor stretched (FR-SHELL-031
// AC5, #522): 24 px with a 4 px radius in the 36 px rail badge, in proportion elsewhere.
export const WorkspaceImageClass = "inline-block h-[1.4em] w-[1.4em] shrink-0 rounded-4 object-contain";

// The trimmed copy of an image (workspace-icon-trim.ts) once it is made; the file itself, fitted, until then.
function useTrimmedSrc(src: string, revision: number): string {
    const key = `${src}#${revision ?? 0}`;
    const [trimmed, setTrimmed] = useState<{ key: string; url: string }>(null);
    useEffect(() => {
        if (!src) {
            return;
        }
        let live = true;
        trimmedIconUrl(src, key).then((url) => {
            if (live && url) {
                setTrimmed({ key, url });
            }
        });
        return () => {
            live = false;
        };
    }, [key]);
    return trimmed?.key === key ? trimmed.url : src;
}

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
    const fileSrc = resolved.kind !== "builtin" ? logoUrl(getWebServerEndpoint(), resolved.path) : "";
    const src = useTrimmedSrc(fileSrc, source?.revision);
    if (resolved.kind !== "builtin") {
        return (
            <img
                key={resolved.path}
                src={src}
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
    // The workspace's colour at its glyph tone (tokens.css), readable on every surface whatever the colour; a gradient
    // at the same tone, stop by stop.
    const stops = source?.stops?.length > 1 && resolved.color ? source.stops : null;
    return (
        <i
            className={cn(
                makeIconClass(resolved.icon, false),
                resolved.color && "molten-glyph-tone",
                stops && "molten-glyph-gradient",
                className
            )}
            style={resolved.color ? glyphStyle(resolved.color, stops) : undefined}
            data-icon-kind="builtin"
        />
    );
}

function glyphStyle(color: string, stops: string[]): React.CSSProperties {
    if (stops == null) {
        return { "--mt-glyph-color": color } as React.CSSProperties;
    }
    return {
        "--mt-glyph-color": stops[0],
        "--mt-glyph-mid": stops.length > 2 ? stops[1] : `color-mix(in srgb, ${stops[0]} 50%, ${stops[1]})`,
        "--mt-glyph-end": stops[stops.length - 1],
    } as React.CSSProperties;
}

// The URL a workspace's image (imported, or its project's logo) is read from; "" when it shows its symbol.
export function workspaceImageUrl(source: WorkspaceIconSource): string {
    const resolved = resolveWorkspaceIcon(source, getDataDir());
    return resolved.kind === "builtin" ? "" : logoUrl(getWebServerEndpoint(), resolved.path);
}

// A badge for a folder that is not a workspace (a project's logo, or a folder glyph).
export function folderIconSource(logo: string): WorkspaceIconSource {
    return { icon: "folder", color: "", image: "", logo: logo ?? "" };
}
