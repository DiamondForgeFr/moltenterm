// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { useHoldSettings } from "./hold-to-confirm";

// The SVG filter that joins the item's tile, the neck and the badge into one droplet (DS-SHELL-061); the rail draws it
// once.
export const RailBudFilterId = "molten-rail-bud-goo";

export function railEditLabel(name: string): string {
    return `Edit ${name}`;
}

// A metaball filter: the blur spreads the shapes' alpha into each other, the threshold cuts it back to a hard edge, so
// close shapes read as one with a neck. The threshold sits at half alpha, where a blurred straight edge stays in place:
// the item's tile keeps its outline and only stretches where the neck leaves it. It runs in sRGB: the default linear
// RGB shifts the neck's colour off the tile's.
export function RailBudFilter() {
    return (
        <svg className="pointer-events-none absolute h-0 w-0" aria-hidden focusable="false">
            <defs>
                <filter
                    id={RailBudFilterId}
                    x="-50%"
                    y="-50%"
                    width="200%"
                    height="200%"
                    colorInterpolationFilters="sRGB"
                >
                    <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur" />
                    <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 40 -19.5" />
                </filter>
            </defs>
        </svg>
    );
}

// The pencil of a rail item (FR-SHELL-030-AC1): a sibling of the item's button, so it is its own tab stop right after
// it, shown while the item is hovered or holds the focus.
// #365 (DS-SHELL-061): it no longer sits on the item. Its bottom-left 24 px target covered a quarter of the icon, the
// centre included, and swallowed the clicks and drags meant for the item. It buds out of the icon's right edge instead,
// like a cell dividing, and settles just before the pinch-off: a 16 px badge still joined to the icon by a thin neck,
// whose target lies wholly outside the icon. It is anchored to the item's button (moltenterm-shell.css) and fixed, so
// the rail's narrow, scrolling box neither clips nor holds it.
// #354 (DS-SHELL-058) made the sheet open after a press-and-hold, the gesture of the tab close button, while the pencil
// sat on the icon and caught stray clicks. Out of the icon since #365, it opens on a simple click again (#368, revision
// of FR-SHELL-030, 2026-10-08); the tab close button keeps its hold.
export function RailEditButton({
    name,
    onEdit,
    onHover,
    onLeave,
}: {
    name: string;
    onEdit: (opener: HTMLElement) => void;
    onHover: (opener: HTMLElement) => void;
    onLeave: () => void;
}) {
    const { reducedMotion } = useHoldSettings();
    // The badge has no edge of its own: a ring would cut the neck that joins it to its item. The goo drop under it is
    // the same disc, so the droplet reads as one shape.
    return (
        <span className="molten-rail-bud" data-reduced-motion={reducedMotion ? "" : undefined}>
            <span className="molten-rail-bud-clip" aria-hidden>
                <span className="molten-rail-bud-goo" style={{ filter: `url(#${RailBudFilterId})` }}>
                    <span className="molten-rail-bud-tile" />
                    <span className="molten-rail-bud-stub" />
                    <span className="molten-rail-bud-drop" />
                </span>
            </span>
            <button
                type="button"
                aria-label={railEditLabel(name)}
                data-role="rail-edit"
                draggable={false}
                onClick={(e) => onEdit(e.currentTarget)}
                onMouseEnter={(e) => onHover(e.currentTarget)}
                onMouseLeave={onLeave}
                className="molten-rail-edit absolute inset-0 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full"
            >
                <span className="molten-rail-bud-disc relative inline-flex h-4 w-4 items-center justify-center rounded-full bg-[var(--molten-rail-bud-fill)] text-[8px] text-secondary hover:text-primary">
                    <i className="fa fa-solid fa-pencil" aria-hidden />
                </span>
            </button>
        </span>
    );
}
