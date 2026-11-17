// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's portrait (FR-BOSS-001, AC1, AC12; FR-BOSS-007): his validated still, framed on his head. The framing lives in
// one place, boss-portrait.css (--mt-boss-head-scale, --mt-boss-head-origin), and the frame is the one the bubble's
// round, the open comm screen and the card's header all draw. The still is always there. Asked for (`live`), his
// animated portrait (brokk-live.tsx) loads and plays over it in the same frame; until it plays, when it cannot load or
// play, and under reduced motion, the still is what shows. A portrait that fails to load or to draw is tried again
// (boss-portrait-retry.ts, #2219).

import { Component, lazy, memo, Suspense } from "react";
import { LiveRetry } from "./boss-portrait-retry";
import "./boss-portrait.css";
import type { BrokkLiveProps } from "./brokk-live";
import BrokkStill from "./portrait/brokk/brokk.jpg";

const makeLazyLive = () => lazy(() => import("./brokk-live").then((m) => ({ default: m.BrokkLive })));

// A `lazy` whose import failed stays failed for good, so a retry needs a new one. The generation tells a boundary whether
// the lazy it drew is still the current one: a failure of an old lazy must not replace a new one that loads.
let LazyBrokkLive = makeLazyLive();
let LiveGeneration = 0;

function renewLive(failedGeneration: number): void {
    if (failedGeneration !== LiveGeneration) {
        return;
    }
    LazyBrokkLive = makeLazyLive();
    LiveGeneration++;
}

// A portrait that fails to load or to draw leaves the still, never a hole in the bubble, and is tried again.
export class LiveBoundary extends Component<{ live: BrokkLiveProps }, { failed: boolean }> {
    state = { failed: false };
    drawn = LiveGeneration;
    retry = new LiveRetry({
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        retry: () => this.setState({ failed: false }),
    });

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        console.log("brokk live portrait failed, the still stays until it is tried again", error);
        renewLive(this.drawn);
        this.retry.failed();
    }

    componentWillUnmount() {
        this.retry.cancel();
    }

    render() {
        if (this.state.failed) {
            return null;
        }
        const Live = LazyBrokkLive;
        this.drawn = LiveGeneration;
        return (
            <Suspense fallback={null}>
                <Live {...this.props.live} />
            </Suspense>
        );
    }
}

// framing: "head" (the default) is the avatar's round on his head, "banner" the panel's top, edge to edge (boss-portrait.css).
// Memoised: the surfaces hand a `live` that only changes with what it shows, and a draw of the surface around it (a
// badge, an agent's state) must not draw the animated portrait again.
export const BossPortrait = memo(function BossPortrait({
    live,
    framing = "head",
}: {
    live?: BrokkLiveProps;
    framing?: "head" | "banner";
}) {
    return (
        <span className="mt-boss-portrait" data-framing={framing} aria-hidden>
            <img className="mt-boss-portrait-image" src={BrokkStill} alt="" draggable={false} />
            {live != null ? <LiveBoundary live={live} /> : null}
        </span>
    );
});
