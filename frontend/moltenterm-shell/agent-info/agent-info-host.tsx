// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import { lazy, Suspense } from "react";
import { AgentInfoModel } from "./agent-info-store";

// Loaded on demand: the window only shows once an agent's "Everything about" link is clicked, so its code stays out of
// the JS every tab view loads up front (NFR-PERF-003, bundle.initialJsMB).
const AgentInfoWindow = lazy(() => import("./agent-info-window").then((m) => ({ default: m.AgentInfoWindow })));
const SubagentInfoWindow = lazy(() =>
    import("./subagent-info-window").then((m) => ({ default: m.SubagentInfoWindow }))
);

export function AgentInfoHost() {
    const model = AgentInfoModel.getInstance();
    const blockId = useAtomValue(model.openAtom);
    const sub = useAtomValue(model.openSubAtom);
    if (sub != null) {
        return (
            <Suspense fallback={null}>
                <SubagentInfoWindow
                    key={`${sub.blockId}:${sub.id}`}
                    blockId={sub.blockId}
                    subId={sub.id}
                    onClose={() => model.closeSub()}
                />
            </Suspense>
        );
    }
    if (!blockId) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <AgentInfoWindow key={blockId} blockId={blockId} onClose={() => model.close()} />
        </Suspense>
    );
}
