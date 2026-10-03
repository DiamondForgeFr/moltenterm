// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The status bar (FR-SHELL-008): which build of Moltenterm runs, as in Notulia.

import { getApi } from "@/app/store/global";
import { cn } from "@/util/util";
import { useMemo } from "react";
import type { MoltentermBuildInfo } from "./build/build-info";
import { makeStatusBarView, MoltentermDevChannelText, StatusBarChannel } from "./status-bar-model";
import { GoldUpdateButton } from "./update/update-dialog";

// Badges keep a fixed colour per channel, apart from the workspace accent: a gold or dev build must be recognisable
// in any workspace.
const ChannelClasses: Record<StatusBarChannel, string> = {
    dev: cn("border-sky-400/60", MoltentermDevChannelText),
    local: "border-amber-500/60 text-amber-400",
    gold: "border-yellow-400/70 text-yellow-300",
    release: "border-border text-secondary",
};

function readBuildInfo(): MoltentermBuildInfo {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
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
    return (
        <footer
            title={view.tooltip}
            className="molten-status-bar flex h-[24px] shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-secondary select-none"
        >
            <span className={cn("rounded border px-1.5 leading-[16px]", ChannelClasses[view.channel])}>
                {view.channelLabel}
            </span>
            {view.branch ? (
                <span className="flex items-center gap-1">
                    <i className="fa fa-solid fa-code-branch text-[10px]" />
                    {view.branch}
                </span>
            ) : null}
            {view.shortCommit ? (
                <span className="font-mono text-muted">
                    {view.shortCommit}
                    {view.dirty ? <span title="uncommitted changes"> ●</span> : null}
                </span>
            ) : null}
            <span className="ml-auto flex items-center gap-3">
                <GoldUpdateButton />
                <span>MoltenTerm {view.version}</span>
            </span>
        </footer>
    );
}
