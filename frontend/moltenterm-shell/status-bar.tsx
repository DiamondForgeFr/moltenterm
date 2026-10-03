// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The status bar: the focused pane's project, branch, local CI verdict and pull request on the left (FR-SHELL-010);
// the build of Moltenterm that runs as one badge on the right, next to the gold update button (FR-SHELL-008).

import { atoms, getApi, openLink } from "@/app/store/global";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { MoltentermBuildInfo } from "./build/build-info";
import { MoltentermCicdView } from "./mission/cicd-view";
import { MoltentermTimelineView } from "./mission/timeline-view";
import { openMoltentermView } from "./open-view";
import { usePaneStatus, useWarmLinkedProject } from "./pane-status";
import {
    makePaneView,
    makeStatusBarView,
    MoltentermDevChannelText,
    PaneBlockMeta,
    PaneView,
    StatusBarChannel,
    statusBarFolder,
} from "./status-bar-model";
import { GoldUpdateButton } from "./update/update-dialog";
import { WorkspaceIcon } from "./workspace-icon";
import { readWorkspaceProject } from "./workspace-project";

const NoFocusedNode = atom(null) as Atom<{ data?: { blockId?: string } }>;

// Badges keep a fixed colour per channel, apart from the workspace accent: a gold or dev build must be recognisable
// in any workspace.
const ChannelClasses: Record<StatusBarChannel, string> = {
    dev: cn("border-sky-400/60", MoltentermDevChannelText),
    local: "border-amber-500/60 text-amber-400",
    gold: "border-yellow-400/70 text-yellow-300",
    release: "border-border text-secondary",
};

const ItemButton = "flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 hover:bg-hover hover:text-primary";

function readBuildInfo(): MoltentermBuildInfo {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
}

function FocusedBlockMeta({ blockId, onMeta }: { blockId: string; onMeta: (meta: PaneBlockMeta) => void }) {
    const [block] = useWaveObjectValue<Block>(makeORef("block", blockId));
    const view = block?.meta?.view;
    const connection = block?.meta?.connection;
    const cwd = block?.meta?.["cmd:cwd"];
    useEffect(() => {
        onMeta(block == null ? null : { view, connection, "cmd:cwd": cwd });
    }, [block == null, view, connection, cwd, onMeta]);
    return null;
}

function PaneSection({ pane, ws }: { pane: PaneView; ws: Workspace }) {
    const openView = (view: string) => fireAndForget(() => openMoltentermView(view));
    return (
        <span className="flex min-w-0 items-center gap-2">
            <span className="flex min-w-0 items-center gap-1" title={pane.projectTitle}>
                {pane.linked ? (
                    <WorkspaceIcon
                        icon={ws?.icon}
                        color={ws?.color}
                        logo={readWorkspaceProject(ws).logo || pane.projectLogo}
                        className="text-[11px]"
                    />
                ) : (
                    <WorkspaceIcon icon="folder" logo={pane.projectLogo} className="text-[11px]" />
                )}
                <span className="truncate text-primary">{pane.projectName}</span>
            </span>
            {pane.branch ? (
                <button
                    type="button"
                    className={ItemButton}
                    title={pane.branchTitle}
                    onClick={() => openView(MoltentermTimelineView)}
                >
                    <i className="fa fa-solid fa-code-branch text-[10px]" />
                    <span className="truncate">{pane.branch}</span>
                    {pane.ahead > 0 ? <span className="text-muted">↑{pane.ahead}</span> : null}
                    {pane.dirty ? <span className="text-warning">●</span> : null}
                </button>
            ) : null}
            {pane.ci ? (
                <button
                    type="button"
                    className={ItemButton}
                    title={`${pane.ci.label} on this code\nOpen CI/CD`}
                    onClick={() => openView(MoltentermCicdView)}
                >
                    <i
                        className={cn(
                            "fa fa-solid text-[10px]",
                            `fa-${pane.ci.icon}`,
                            pane.ci.status === "running" && "fa-spin",
                            pane.ci.className
                        )}
                    />
                    {pane.ci.label}
                </button>
            ) : null}
            {pane.pr ? (
                <button
                    type="button"
                    className={ItemButton}
                    title={`${pane.pr.draft ? "Draft pull request" : "Pull request"}: ${pane.pr.title}`}
                    onClick={() => fireAndForget(() => openLink(pane.pr.url))}
                >
                    <i className="fa fa-solid fa-code-pull-request text-[10px]" />#{pane.pr.number}
                </button>
            ) : null}
        </span>
    );
}

export function StatusBar() {
    const view = useMemo(() => {
        const api = getApi();
        return makeStatusBarView(readBuildInfo(), {
            isDev: api.getIsDev(),
            runtimeChannel: api.getEnv("MOLTENTERM_CHANNEL"),
            version: api.getAboutModalDetails()?.version ?? "",
        });
    }, []);
    const ws = useAtomValue(atoms.workspace);
    const focusedAtom = useMemo(() => getLayoutModelForStaticTab()?.focusedNode ?? NoFocusedNode, []);
    const focused = useAtomValue(focusedAtom);
    const blockId = focused?.data?.blockId;
    const [meta, setMeta] = useState<PaneBlockMeta>(null);
    useEffect(() => {
        if (!blockId) {
            setMeta(null);
        }
    }, [blockId]);
    const { folder, fromPane } = statusBarFolder(meta, ws);
    const state = usePaneStatus(folder, fromPane ? blockId : null);
    useWarmLinkedProject(readWorkspaceProject(ws).dir);
    const pane = folder ? makePaneView(folder, state, ws) : null;
    return (
        <footer className="molten-status-bar flex h-[24px] shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-secondary select-none">
            {blockId ? <FocusedBlockMeta key={blockId} blockId={blockId} onMeta={setMeta} /> : null}
            {pane ? <PaneSection pane={pane} ws={ws} /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-3">
                <GoldUpdateButton />
                <span
                    title={view.tooltip}
                    className={cn("rounded border px-1.5 leading-[16px]", ChannelClasses[view.channel])}
                >
                    {view.badge}
                </span>
            </span>
        </footer>
    );
}
