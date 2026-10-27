// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace sidebar (#1183, FR-SHELL-079) in a window-sized frame, on mock objects: a workspace with its Project
// tab (a tile) and three temporary views, to compare with the #1181 prototype.

import { mockObjectForPreview } from "@/app/store/wos";
import { PreviewTabId, PreviewWindowId, PreviewWorkspaceId } from "@/preview/mock/mockwaveenv";
import { SidebarContentStrip, WorkspaceSidebar } from "../../moltenterm-shell/sidebar/workspace-sidebar";

const ProjectTabId = "preview-sidebar-project";
const OtherTabIds = ["preview-sidebar-review", "preview-sidebar-docs"];

function seed() {
    mockObjectForPreview<WaveWindow>(`window:${PreviewWindowId}`, {
        otype: "window",
        oid: PreviewWindowId,
        version: 1,
        workspaceid: PreviewWorkspaceId,
        pos: { x: 0, y: 0 },
        winsize: { width: 1100, height: 720 },
        lastfocusts: 0,
        meta: {},
    });
    mockObjectForPreview<Workspace>(`workspace:${PreviewWorkspaceId}`, {
        otype: "workspace",
        oid: PreviewWorkspaceId,
        version: 1,
        name: "MoltenTerm",
        icon: "fire",
        color: "#ff7c0d",
        tabids: [ProjectTabId, PreviewTabId, ...OtherTabIds],
        activetabid: PreviewTabId,
        meta: { "molten:projecttype": "Desktop" } as MetaType,
    });
    const tab = (oid: string, name: string, meta: Record<string, any> = {}): Tab =>
        ({ otype: "tab", oid, version: 1, name, blockids: [], meta }) as Tab;
    mockObjectForPreview(`tab:${ProjectTabId}`, tab(ProjectTabId, "Project", { "molten:projecttab": true }));
    mockObjectForPreview(`tab:${PreviewTabId}`, tab(PreviewTabId, "Valentin · #1183"));
    mockObjectForPreview(`tab:${OtherTabIds[0]}`, tab(OtherTabIds[0], "Review #1190"));
    mockObjectForPreview(`tab:${OtherTabIds[1]}`, tab(OtherTabIds[1], "Docs", { "tab:flagcolor": "#429DFF" }));
}

seed();

export function SidebarPreview() {
    return (
        <div
            className="relative flex overflow-hidden rounded-6 border border-border"
            style={{ width: 1100, height: 720, background: "#3a2416" }}
            data-testid="sidebar-preview-frame"
        >
            <WorkspaceSidebar />
            <div className="flex min-w-0 flex-grow flex-col overflow-hidden pr-[5px] pb-2">
                <SidebarContentStrip />
                <div className="flex min-h-0 flex-grow gap-1.5">
                    <div className="flex-1 rounded-6 bg-[#1b1917] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]" />
                    <div className="flex-1 rounded-6 bg-[#1b1917] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]" />
                </div>
            </div>
        </div>
    );
}
