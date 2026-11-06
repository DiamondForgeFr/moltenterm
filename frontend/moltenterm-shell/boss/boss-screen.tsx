// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the open comm screen lays over the portrait (FR-BOSS-001, AC12), in the style of DiamondForge's transmission
// portrait: an ember tint, scanlines, a slow sweep, a vignette, four viewfinder corners, the "Online" mark, and at the
// bottom his name, a state mark and his status. Drawn only while the screen is open, so nothing runs at rest. It is
// for the eyes only: the bubble's name and description say the same to screen readers. The status says what his face
// shows (FR-BOSS-007, AC9 and AC11): it is the scene's caption (brokk-scene.ts), the same sentence the hover card
// starts with, and the domino, the sign of work, shows only while agents work.

import { useT, useTCount } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import "./boss-screen.css";
import type { BrokkScene, CaptionLine } from "./brokk-scene";

const CornerPlaces = ["tl", "tr", "bl", "br"] as const;

// A line of the scene, in the language of the app: the source's own text, or a key with its count and variables.
export function useCaptionText(): (line: CaptionLine) => string {
    const t = useT();
    const tCount = useTCount();
    return (line) => {
        if (line.text != null) {
            return line.text;
        }
        return line.count != null ? tCount(line.key, line.count, line.vars) : t(line.key, line.vars);
    };
}

export function BossScreen({ name, scene }: { name: string; scene: BrokkScene }) {
    const t = useT();
    const text = useCaptionText();
    const { caption } = scene;
    return (
        <span
            className="mt-boss-screen"
            data-testid="boss-screen"
            data-mood={scene.mood.mood}
            data-mt-dark-surface=""
            aria-hidden
        >
            <span className="mt-boss-fx mt-boss-tint" />
            <span className="mt-boss-fx mt-boss-scan" />
            <span className="mt-boss-fx mt-boss-sweep" />
            <span className="mt-boss-fx mt-boss-vignette" />
            {CornerPlaces.map((place) => (
                <span key={place} className="mt-boss-fx mt-boss-corner" data-at={place} />
            ))}
            <span className="mt-boss-fx mt-boss-live">
                <i />
                {t("boss.screen.online")}
            </span>
            <span className="mt-boss-fx mt-boss-caption">
                <span className="mt-boss-caption-name">
                    <span className="mt-boss-caption-text">{name}</span>
                    {scene.loader ? <DominoLoader /> : null}
                </span>
                <span className="mt-boss-caption-status" data-testid="boss-screen-status">
                    {text(caption.status)}
                </span>
                {caption.detail ? (
                    <span className="mt-boss-caption-detail" data-testid="boss-screen-detail">
                        {text(caption.detail)}
                    </span>
                ) : null}
            </span>
        </span>
    );
}
