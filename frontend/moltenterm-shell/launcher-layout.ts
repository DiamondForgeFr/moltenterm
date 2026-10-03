// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Grid and logo sizes for Wave's widget launcher (frontend/app/view/launcher/launcher.tsx). Pure functions so the
// layout can be tested without a pane.

export type LauncherGrid = { columns: number; tileWidth: number; tileHeight: number; showLabel: boolean };

export type LauncherLogo = { show: boolean; width: number; height: number };

export const LauncherGap = 16;
export const LauncherLabelThreshold = 60;
export const LauncherMaxTileSize = 120;

const LogoAspect = 264 / 330;
const LogoMarginBottom = 16;
const LogoMinWidth = 40;
const LogoMaxWidth = 72;
const LogoMinPaneWidth = 160;

// A layout whose tiles are at least this share of the best tile size may be chosen to avoid an orphan tile.
const OrphanTolerance = 0.8;

// The logo is a quiet mark, not the headline: it stays small and gives its height back to the tiles.
export function launcherLogo(paneWidth: number): LauncherLogo {
    if (paneWidth < LogoMinPaneWidth) {
        return { show: false, width: 0, height: 0 };
    }
    const width = Math.min(Math.max(paneWidth * 0.12, LogoMinWidth), LogoMaxWidth);
    return { show: true, width, height: width * LogoAspect };
}

export function launcherLogoReservedHeight(logo: LauncherLogo): number {
    return logo.show ? logo.height + LogoMarginBottom : 0;
}

function hasOrphan(count: number, columns: number): boolean {
    return count > 2 && columns > 1 && count % columns === 1;
}

// Wave picks the column count that gives the largest tile, which can leave one tile alone on the last row (seven
// widgets in three columns). Tiles are capped, so several counts often tie: among layouts close to the best, prefer
// one without an orphan.
export function launcherGrid(count: number, width: number, height: number): LauncherGrid {
    if (width <= 0 || height <= 0 || count === 0) {
        return { columns: 1, tileWidth: 90, tileHeight: 90, showLabel: true };
    }
    type Candidate = LauncherGrid & { size: number; capped: number };
    const candidates: Candidate[] = [];
    for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        const tileWidth = (width - (cols - 1) * LauncherGap) / cols;
        const tileHeight = (height - (rows - 1) * LauncherGap) / rows;
        const size = Math.min(tileWidth, tileHeight);
        candidates.push({
            columns: cols,
            tileWidth,
            tileHeight,
            showLabel: tileHeight >= LauncherLabelThreshold,
            size,
            capped: Math.min(size, LauncherMaxTileSize),
        });
    }
    const byQuality = (a: Candidate, b: Candidate) => b.capped - a.capped || b.size - a.size || a.columns - b.columns;
    candidates.sort(byQuality);
    let best = candidates[0];
    if (hasOrphan(count, best.columns)) {
        const alternative = candidates.find((c) => !hasOrphan(count, c.columns));
        if (alternative != null && alternative.capped >= best.capped * OrphanTolerance) {
            best = alternative;
        }
    }
    return { columns: best.columns, tileWidth: best.tileWidth, tileHeight: best.tileHeight, showLabel: best.showLabel };
}
