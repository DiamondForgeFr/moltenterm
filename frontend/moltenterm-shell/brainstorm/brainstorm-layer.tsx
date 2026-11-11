// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The brainstorm layer's place in Brokk's host (FR-BOSS-010 AC2, AC19, NFR-BOSS-009, #2246): it starts the watch of the
// mode in every tab view (its state is wavesrv's, so a tab switch finds it, brainstorm-boot.ts), and shows the layer while
// the mode is on. What the layer draws (brainstorm-view.tsx) loads behind this one import() the first time the mode
// opens, and the 3D scene behind the stage's own: a window that never brainstorms carries neither, and a release channel
// starts nothing.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useState } from "react";
import { useBrainstormAllowed } from "../build/use-feature-on";
import { prefersReducedMotion } from "../molten-motion";
import { bootBrainstorm, BrainstormStateAtom } from "./brainstorm-boot";

const BrainstormView = lazy(() => import("./brainstorm-view").then((mod) => ({ default: mod.BrainstormView })));

// The layer stays this long after the mode ends, for its fade.
const LeaveMs = 420;
const LeaveReducedMs = 150;

function useLayerLife(open: boolean): { mounted: boolean; shown: boolean } {
    const [mounted, setMounted] = useState(open);
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (open) {
            setMounted(true);
            let second = 0;
            const first = requestAnimationFrame(() => {
                second = requestAnimationFrame(() => setShown(true));
            });
            return () => {
                cancelAnimationFrame(first);
                cancelAnimationFrame(second);
            };
        }
        setShown(false);
        const timer = setTimeout(() => setMounted(false), prefersReducedMotion() ? LeaveReducedMs : LeaveMs);
        return () => clearTimeout(timer);
    }, [open]);
    return { mounted, shown };
}

export function BrainstormLayer() {
    const state = useAtomValue(BrainstormStateAtom, { store: globalStore });
    const allowed = useBrainstormAllowed();
    const open = allowed && state?.open === true;
    const life = useLayerLife(open);
    // The watch follows the developer's switch (FR-BOSS-011): off, it stops and the state of the mode is forgotten in
    // this view, so Brokk's group and his field leave the brainstorm layout too; on again, it watches again.
    useEffect(() => bootBrainstorm(), [allowed]);
    useEffect(() => {
        if (!allowed) {
            globalStore.set(BrainstormStateAtom, null);
        }
    }, [allowed]);
    if (!life.mounted || state == null) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <BrainstormView state={state} shown={life.shown && open} />
        </Suspense>
    );
}
