// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the open comm screen lays over the portrait (FR-BOSS-001, AC12), in the style of DiamondForge's transmission
// portrait: an ember tint, scanlines, a slow sweep, a vignette, four viewfinder corners, the "Online" mark, and at the
// bottom his name, a state mark and one status line. Drawn only while the screen is open, so nothing runs at rest. It is
// for the eyes only: the bubble's name and description say the same to screen readers.

import { useT, useTCount } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import "./boss-screen.css";

const CornerPlaces = ["tl", "tr", "bl", "br"] as const;

export function BossScreen({ name, count }: { name: string; count: number }) {
    const t = useT();
    const tCount = useTCount();
    const status = count > 0 ? tCount("boss.screen.toHandle", count) : t("boss.screen.quiet");
    return (
        <span className="mt-boss-screen" data-testid="boss-screen" data-mt-dark-surface="" aria-hidden>
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
                    <DominoLoader />
                </span>
                <span className="mt-boss-caption-status">{status}</span>
            </span>
        </span>
    );
}
