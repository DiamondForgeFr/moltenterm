// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Resetting the last workspace (#222): the rail and the workspace editor offer it in place of a delete that would
// leave the window without a workspace. The dialog names what is lost; Electron then resets the workspace in the window
// that shows it (emain/emain-window.ts, "reset-workspace").

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService, WorkspaceService } from "@/app/store/services";
import { makeORef } from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { DialogFrame, useEscape } from "./dialog-frame";
import { MoltenWave } from "./molten-button";
import { resetLossText } from "./workspace-reset-model";

const PlainButton =
    "cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary";
const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded px-3 py-1.5 text-xs";

type ResetRequest = { workspaceId: string; name: string; tabCount: number; paneCount: number };

const ResetRequestAtom = atom(null) as PrimitiveAtom<ResetRequest>;

async function countPanes(tabIds: string[]): Promise<number> {
    if (tabIds.length === 0) {
        return 0;
    }
    const tabs = (await ObjectService.GetObjects(tabIds.map((id) => makeORef("tab", id)))) as Tab[];
    return (tabs ?? []).reduce((n, tab) => n + (tab?.blockids?.length ?? 0), 0);
}

export function askResetWorkspace(workspaceId: string): void {
    fireAndForget(async () => {
        const ws = await WorkspaceService.GetWorkspace(workspaceId);
        if (ws == null) {
            return;
        }
        const tabIds = ws.tabids ?? [];
        let paneCount = 0;
        try {
            paneCount = await countPanes(tabIds);
        } catch (e) {
            console.log("panes of the workspace to reset", e);
        }
        globalStore.set(ResetRequestAtom, {
            workspaceId,
            name: ws.name || "Unsaved workspace",
            tabCount: tabIds.length,
            paneCount,
        });
    });
}

export function WorkspaceResetHost() {
    const request = useAtomValue(ResetRequestAtom);
    const cancel = () => globalStore.set(ResetRequestAtom, null);
    useEscape(request != null, cancel);
    if (request == null) {
        return null;
    }
    const reset = () => {
        globalStore.set(ResetRequestAtom, null);
        getApi().resetWorkspace(request.workspaceId);
    };
    return (
        <DialogFrame
            role="workspace-reset"
            title={`Reset the workspace "${request.name}"?`}
            subtitle="It is your only workspace, so it is reset rather than deleted."
            buttons={
                <>
                    <button type="button" className={PlainButton} onClick={cancel}>
                        Cancel
                    </button>
                    <button type="button" className={DangerButton} onClick={reset} autoFocus>
                        Reset workspace
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <p>{resetLossText(request.tabCount, request.paneCount)}</p>
            <p className="text-secondary">
                The workspace starts again with one new tab. Its name, icon, colour and project link are kept.
            </p>
        </DialogFrame>
    );
}
