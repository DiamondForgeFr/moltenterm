// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mounted once per window view with the sidebar; draws the library while it is open. The library loads on its first
// opening, out of the JS every tab view loads up front (NFR-PERF-003, bundle.initialJsMB).

import { useAtomValue } from "jotai";
import { lazy, Suspense } from "react";
import { SidebarModel } from "../sidebar/sidebar-store";
import type { WorkspaceRailEntry } from "../workspace-rail-model";

const Library = lazy(() => import("./library").then((m) => ({ default: m.Library })));

export function LibraryHost({ entries, onApps }: { entries: WorkspaceRailEntry[]; onApps: () => void }) {
    const section = useAtomValue(SidebarModel.getInstance().libraryAtom);
    if (section == null) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <Library section={section} entries={entries} onApps={onApps} />
        </Suspense>
    );
}
