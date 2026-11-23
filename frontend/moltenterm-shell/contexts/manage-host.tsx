// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where Manage contexts waits until it is asked for (FR-SHELL-158, #2476): the window mounts this once, and the dialog
// with its emblem picker is its own chunk, loaded the first time the developer opens it (NFR-PERF-003: nothing the
// developer may never open is part of the up-front JavaScript).

import { useAtomValue, useSetAtom } from "jotai";
import { lazy, Suspense } from "react";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import { ManageContextsOpenAtom } from "./ribbon-host";

const ManageContextsDialog = lazy(() =>
    import("./manage-contexts").then((m) => ({ default: m.ManageContextsDialog }))
);

export function ManageContextsHost({ entries }: { entries: WorkspaceRailEntry[] }) {
    const open = useAtomValue(ManageContextsOpenAtom);
    const setOpen = useSetAtom(ManageContextsOpenAtom);
    if (!open) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <ManageContextsDialog entries={entries} onClose={() => setOpen(false)} />
        </Suspense>
    );
}
