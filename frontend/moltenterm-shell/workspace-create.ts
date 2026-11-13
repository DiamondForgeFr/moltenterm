// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Creating a workspace (FR-SHELL-082): the sidebar's new-workspace page and a brainstorm's project card (FR-BOSS-010
// AC15, #2250) make it the same way: its name and colour, its project type, then the link to its folder.

import { WorkspaceService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { ProjectTypeMetaKey } from "./sidebar/sidebar-model";
import { colourStops } from "./workspace-colour";
import { linkWorkspaceProject, setWorkspaceGradient } from "./workspace-project-store";

export type WorkspaceDraft = { name: string; colour: string; type?: string; folder?: string };

// Resolves the new workspace's id. Its folder, when given, is linked as its project (linkWorkspaceProject).
export async function createWorkspace(draft: WorkspaceDraft): Promise<string> {
    // A gradient is stored as the sheet stores it (accent.ts): its first stop as the colour, its stops in the meta.
    const stops = colourStops(draft.colour);
    const id = await WorkspaceService.CreateWorkspace(draft.name.trim(), "", stops[0] ?? "", true);
    if (!id) {
        throw new Error("no workspace id");
    }
    if (stops.length > 1) {
        await setWorkspaceGradient(id, stops.join(","));
    }
    const type = (draft.type ?? "").trim();
    if (type) {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("workspace", id),
            meta: { [ProjectTypeMetaKey]: type } as MetaType,
        });
    }
    if (draft.folder) {
        await linkWorkspaceProject({ oid: id } as Workspace, draft.folder);
    }
    return id;
}
