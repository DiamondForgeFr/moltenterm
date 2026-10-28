// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mounted once by the rail, in every tab view: it shows the sheet of the open request, and picks up a double-click
// handed over by the tab view the window switched away from. The sheet loads on its first opening, out of the JS
// every tab view loads up front (NFR-PERF-003, bundle.initialJsMB).

import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect } from "react";
import { listenWorkspaceMenu, pickUpWorkspaceEdit, WorkspaceEditModel } from "./workspace-edit";
import { WorkspaceEditIntentKey } from "./workspace-edit-model";
import { canCloseWorkspace } from "./workspace-reset-model";

const WorkspaceEditSheet = lazy(() =>
    import("./workspace-edit-sheet").then((m) => ({ default: m.WorkspaceEditSheet }))
);

export function WorkspaceEditHost({ entries }: { entries: { id: string }[] }) {
    const model = WorkspaceEditModel.getInstance();
    const request = useAtomValue(model.requestAtom);
    const ws = useAtomValue(atoms.workspace);
    const staticTabId = useAtomValue(atoms.staticTabId);
    const close = () => model.close();
    useEffect(() => {
        listenWorkspaceMenu();
        const onStorage = (e: StorageEvent) => {
            if (e.key === WorkspaceEditIntentKey) {
                pickUpWorkspaceEdit();
            }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);
    useEffect(() => {
        pickUpWorkspaceEdit();
    }, [ws?.oid, ws?.activetabid, staticTabId]);
    if (request == null) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <WorkspaceEditSheet
                key={request.workspaceId}
                workspaceId={request.workspaceId}
                closable={canCloseWorkspace(entries, request.workspaceId)}
                onClose={close}
            />
        </Suspense>
    );
}
