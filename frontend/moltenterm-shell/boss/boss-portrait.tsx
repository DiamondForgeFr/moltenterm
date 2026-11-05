// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's portrait (FR-BOSS-001, AC1, AC12; FR-BOSS-007): his validated still, framed on his head. The framing lives in
// one place, boss-portrait.css (--mt-boss-head-scale, --mt-boss-head-origin), and the frame is the one the bubble's
// round, the open comm screen and the card's header all draw. The still is always there. Asked for (`live`), his
// animated portrait (brokk-live.tsx) loads and plays over it in the same frame; until it plays, when it cannot load or
// play, and under reduced motion, the still is what shows.

import { Component, lazy, ReactNode, Suspense } from "react";
import "./boss-portrait.css";
import type { BrokkLiveProps } from "./brokk-live";
import BrokkStill from "./portrait/brokk/brokk.jpg";

const LazyBrokkLive = lazy(() => import("./brokk-live").then((m) => ({ default: m.BrokkLive })));

// A portrait that fails to load or to draw leaves the still, never a hole in the bubble.
class LiveBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        console.log("brokk live portrait failed, the still stays", error);
    }

    render() {
        return this.state.failed ? null : this.props.children;
    }
}

export function BossPortrait({ live }: { live?: BrokkLiveProps }) {
    return (
        <span className="mt-boss-portrait" aria-hidden>
            <img className="mt-boss-portrait-image" src={BrokkStill} alt="" draggable={false} />
            {live != null ? (
                <LiveBoundary>
                    <Suspense fallback={null}>
                        <LazyBrokkLive {...live} />
                    </Suspense>
                </LiveBoundary>
            ) : null}
        </span>
    );
}
