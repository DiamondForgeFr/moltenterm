// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { Fragment } from "react";
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
// #368 (DS-MC-029): the pencil is the first bud of a chain, in this order: pencil, link (FR-MC-032), coffee (#276).
// Each later bud is a 16 px badge with a 24 px target, 4 px past the previous one and joined to it by the same neck, so
// the chain reads as one droplet growing out of the tile; a bud that does not apply is absent.
export type RailBudKind = "edit" | "link";

export type RailBudSpec = {
    kind: RailBudKind;
    // The accessible name; the hover tooltip says the same.
    label: string;
    // A toggle's state (the link bud while its item is in connect mode): the bud stays out and filled.
    pressed?: boolean;
    onActivate: (button: HTMLElement) => void;
};

// One bud's place along the chain, in px from the item's right edge.
export const RailBudPitchPx = 28;

const RailBudGlyphs: Record<RailBudKind, string> = {
    edit: "fa-pencil",
    link: "fa-link",
};

// Where a bud's tooltip goes: past the whole chain, so it never covers the next bud.
export function budTooltipAnchor(opener: HTMLElement): { top: number; left: number } {
    const rect = opener.getBoundingClientRect();
    const chain = opener.closest(".molten-rail-bud")?.getBoundingClientRect();
    return { top: rect.top + rect.height / 2, left: Math.max(rect.right, chain?.right ?? 0) + 6 };
}

export function railLinkLabel(name: string): string {
    return `Group ${name} with other workspaces`;
}

export function RailBudChain({
    buds,
    onHover,
    onLeave,
}: {
    buds: RailBudSpec[];
    onHover: (label: string, opener: HTMLElement) => void;
    onLeave: () => void;
}) {
    const { reducedMotion } = useHoldSettings();
    if (buds.length === 0) {
        return null;
    }
    // The badges have no edge of their own: a ring would cut the necks that join them. The goo drop under each is the
    // same disc, so the chain reads as one shape.
    return (
        <span
            className="molten-rail-bud"
            data-reduced-motion={reducedMotion ? "" : undefined}
            style={{ "--molten-rail-buds": buds.length } as React.CSSProperties}
        >
            <span className="molten-rail-bud-clip" aria-hidden>
                <span className="molten-rail-bud-goo" style={{ filter: `url(#${RailBudFilterId})` }}>
                    <span className="molten-rail-bud-tile" />
                    {buds.map((bud, index) => (
                        <Fragment key={bud.kind}>
                            <span className="molten-rail-bud-stub" style={{ "--i": index } as React.CSSProperties} />
                            <span className="molten-rail-bud-drop" style={{ "--i": index } as React.CSSProperties} />
                        </Fragment>
                    ))}
                </span>
            </span>
            {buds.map((bud, index) => (
                <button
                    key={bud.kind}
                    type="button"
                    aria-label={bud.label}
                    aria-pressed={bud.kind === "link" ? !!bud.pressed : undefined}
                    data-role={`rail-${bud.kind}`}
                    draggable={false}
                    onClick={(e) => bud.onActivate(e.currentTarget)}
                    onMouseEnter={(e) => onHover(bud.label, e.currentTarget)}
                    onMouseLeave={onLeave}
                    className={cn(
                        "molten-rail-budbtn absolute top-0 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full",
                        `molten-rail-${bud.kind}`
                    )}
                    style={{ left: index * RailBudPitchPx, "--i": index } as React.CSSProperties}
                >
                    <span className="molten-rail-bud-disc relative inline-flex h-4 w-4 items-center justify-center rounded-full bg-[var(--molten-rail-bud-fill)] text-[8px] text-secondary hover:text-primary">
                        <i className={cn("fa fa-solid", RailBudGlyphs[bud.kind])} aria-hidden />
                    </span>
                </button>
            ))}
        </span>
    );
}

// The pencil alone, as before the chain.
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
    return (
        <RailBudChain
            buds={[{ kind: "edit", label: railEditLabel(name), onActivate: onEdit }]}
            onHover={(_, opener) => onHover(opener)}
            onLeave={onLeave}
        />
    );
}
