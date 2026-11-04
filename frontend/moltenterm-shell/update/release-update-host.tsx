// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";

// Loaded on demand: the button shows nothing until a check finds a release, and that check waits for the window to go
// idle, so the update's code stays out of the JS every tab view loads up front (NFR-PERF-003, bundle.initialJsMB).
const ReleaseUpdateButton = lazy(() => import("./release-update-ui").then((m) => ({ default: m.ReleaseUpdateButton })));

export function ReleaseUpdateHost() {
    return (
        <Suspense fallback={null}>
            <ReleaseUpdateButton />
        </Suspense>
    );
}
