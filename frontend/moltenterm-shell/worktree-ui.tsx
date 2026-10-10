// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the worktree of a terminal shows (FR-SHELL-016): the pane header's context and its command panel's link
// suggestion (header/panel-header.tsx, FR-SHELL-052), the status bar and the tab tooltip. Closing a linked terminal:
// worktree-close.tsx. The tree comes from the status bar's probe (DS-SHELL-010): one cache in wavesrv, git at most
// once a second per tree.

import { loadAndPinWaveObject, makeORef } from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useCallback, useRef, useState } from "react";
import { paneStatus } from "./pane-status";
import { blockFolder, PaneBlockMeta } from "./status-bar-model";
import { readWorktreeLink, tabTreesTooltip, TreeMarker, treeMarker, treeTooltipLine } from "./worktree-model";

function blockPaneMeta(meta: MetaType): PaneBlockMeta {
    return { view: meta?.view, connection: meta?.connection, "cmd:cwd": meta?.["cmd:cwd"] };
}

export function WorktreeChip({
    marker,
    hideBranch,
    onClick,
    className,
}: {
    marker: TreeMarker;
    hideBranch?: boolean;
    onClick?: () => void;
    className?: string;
}) {
    if (marker == null) {
        return null;
    }
    const showBranch = !hideBranch && marker.branch !== "" && marker.kind === "worktree";
    return (
        <span
            className={cn(
                "inline-flex max-w-[14rem] min-w-[4.5rem] shrink-0 items-center gap-1 rounded-4 border px-1.5 text-11 leading-[16px] whitespace-nowrap",
                marker.colorClass,
                marker.kind === "worktree" && !marker.linked && "border-dashed",
                onClick && "cursor-pointer",
                className
            )}
            title={marker.title}
            data-tree={marker.kind}
            onClick={onClick}
        >
            <i className={cn("fa fa-solid shrink-0 text-11", `fa-${marker.icon}`)} />
            <span className="min-w-0 shrink-0 truncate">{marker.label}</span>
            {showBranch ? <span className="min-w-0 truncate opacity-80">· {marker.branch}</span> : null}
        </span>
    );
}

// The tab tooltip lists the trees of its terminals. Read when the pointer enters the tab, through the same cache.
const TabTooltipMaxAgeMs = 5000;

export function useTabTreesTooltip(tabId: string): { title: string; onMouseEnter: () => void } {
    const [title, setTitle] = useState("");
    const readAt = useRef(0);
    const onMouseEnter = useCallback(() => {
        // Sweeping the pointer across the tabs reads each tab once every few seconds, not on every pass.
        if (Date.now() - readAt.current < TabTooltipMaxAgeMs) {
            return;
        }
        readAt.current = Date.now();
        fireAndForget(async () => {
            const tab = await loadAndPinWaveObject<Tab>(makeORef("tab", tabId));
            const blocks = await Promise.all(
                (tab?.blockids ?? []).map((id) => loadAndPinWaveObject<Block>(makeORef("block", id)))
            );
            const lines = await Promise.all(
                blocks.map(async (block) => {
                    const folder = blockFolder(blockPaneMeta(block?.meta));
                    const link = readWorktreeLink(block?.meta);
                    const dir = folder || (block?.meta?.view === "term" && link.startsWith("/") ? link : "");
                    if (!dir) {
                        return "";
                    }
                    try {
                        return treeTooltipLine(treeMarker(await paneStatus(dir, false, link), link));
                    } catch {
                        return "";
                    }
                })
            );
            setTitle(tabTreesTooltip(lines));
        });
    }, [tabId]);
    return { title, onMouseEnter };
}
