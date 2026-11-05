// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's portrait (FR-BOSS-001, AC1, AC12): his validated still, framed on his head. The framing lives in one place,
// boss-portrait.css (--mt-boss-head-scale, --mt-boss-head-origin), and the frame is the one the bubble's round, the
// open comm screen and the card's header all draw: the animated loops (#1904, FR-BOSS-007) drop in behind the same
// frame, over this image, which stays the fallback.

import "./boss-portrait.css";
import BrokkStill from "./portrait/brokk/brokk.jpg";

export function BossPortrait() {
    return (
        <span className="mt-boss-portrait" aria-hidden>
            <img className="mt-boss-portrait-image" src={BrokkStill} alt="" draggable={false} />
        </span>
    );
}
