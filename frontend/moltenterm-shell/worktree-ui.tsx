// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the worktree of a terminal shows (FR-SHELL-016): the pane header (with the link offer), the status bar and the
// tab tooltip. Closing a linked terminal: worktree-close.tsx. The tree comes from the status bar's probe (DS-SHELL-010):
// one cache in wavesrv, git at most once a second per tree.

import { getWaveObjectAtom, loadAndPinWaveObject, makeORef } from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { paneStatus, usePaneStatus } from "./pane-status";
import { blockFolder, PaneBlockMeta } from "./status-bar-model";
import {
    readWorktreeDismissed,
    readWorktreeLink,
    tabTreesTooltip,
    TreeMarker,
    treeMarker,
    treeTooltipLine,
    worktreeOffer,
} from "./worktree-model";
import { dismissWorktree, linkWorktree, unlinkWorktree } from "./worktree-store";

const ChipButton = "cursor-pointer rounded-6 px-1 hover:bg-hover hover:text-primary";

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

// The header part of a local terminal: its tree, and the link offer when its folder is in a worktree it is not linked
// to. With an agent label (#109) the branch is already shown there.
export function WorktreeHeaderLabel({ blockId, hideBranch }: { blockId: string; hideBranch?: boolean }) {
    const block = useAtomValue(getWaveObjectAtom<Block>(makeORef("block", blockId)));
    const meta = block?.meta;
    const folder = blockFolder(blockPaneMeta(meta));
    const link = readWorktreeLink(meta);
    const local =
        meta?.view === "term" && (meta?.connection == null || meta.connection === "" || meta.connection === "local");
    const probeDir = folder || (local && link.startsWith("/") ? link : "");
    const state = usePaneStatus(probeDir, folder ? blockId : null, link);
    const [busy, setBusy] = useState(false);
    if (!local || !probeDir) {
        return null;
    }
    const marker = treeMarker(state, link);
    const offer = worktreeOffer(state, link, readWorktreeDismissed(meta));
    const act = (fn: () => Promise<void>) =>
        fireAndForget(async () => {
            setBusy(true);
            try {
                await fn();
            } finally {
                setBusy(false);
            }
        });
    const offerName =
        offer
            .split("/")
            .filter((s) => s)
            .pop() ?? offer;
    return (
        <div className="flex shrink-0 items-center gap-1.5 pl-1 pr-1" data-role="molten-tree">
            <WorktreeChip
                marker={marker}
                hideBranch={hideBranch}
                onClick={marker?.kind === "missing" ? () => act(() => unlinkWorktree(blockId)) : undefined}
            />
            {offer ? (
                <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-4 border border-accent/50 bg-accent/10 px-1.5 text-11 leading-[16px] text-secondary"
                    title={`This terminal is in the worktree ${offer}.\nLinked, the header shows it and closing the terminal offers to remove it.`}
                    data-role="molten-worktree-offer"
                >
                    <button
                        type="button"
                        disabled={busy}
                        className={cn(ChipButton, "text-accent")}
                        aria-label={`Link the worktree ${offerName} to this terminal`}
                        onClick={() => act(() => linkWorktree(blockId, offer))}
                    >
                        <i className="fa fa-solid fa-link mr-1 text-11" />
                        Link
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        className={ChipButton}
                        title="Not now (not offered again for this worktree in this terminal)"
                        aria-label="Not now"
                        onClick={() => act(() => dismissWorktree(blockId, readWorktreeDismissed(meta), offer))}
                    >
                        <i className="fa fa-solid fa-xmark text-11" />
                    </button>
                </span>
            ) : null}
        </div>
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
