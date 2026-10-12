// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mounts the version history while it is open (FR-REL-004). The window loads on its first opening (FR-PERF-007): the
// notes it bundles and the markdown renderer never reach the entry every tab view evaluates.

import { useAtomValue } from "jotai";
import { lazy, Suspense } from "react";
import { ReleaseNotesModel } from "./release-notes-store";

const ReleaseNotesWindow = lazy(() =>
    import("./release-notes-window").then((m) => ({ default: m.ReleaseNotesWindow }))
);

export function ReleaseNotesHost() {
    const open = useAtomValue(ReleaseNotesModel.getInstance().openAtom);
    if (!open) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <ReleaseNotesWindow />
        </Suspense>
    );
}
