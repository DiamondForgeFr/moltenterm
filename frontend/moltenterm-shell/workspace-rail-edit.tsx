// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { Fragment, useEffect, useRef, useState } from "react";
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
// #276 (DS-SHELL-062): the coffee keeps the computer awake while the workspace works; a toggle, filled in the awake
// colour while on.
export type RailBudKind = "edit" | "link" | "coffee";

export type RailBudSpec = {
    kind: RailBudKind;
    // The accessible name; the hover tooltip says the same unless tooltip is set.
    label: string;
    tooltip?: string;
    // A toggle's state (the link bud while its item is in connect mode, the coffee while on): the bud is filled.
    pressed?: boolean;
    onActivate: (button: HTMLElement) => void;
};

// #390 (DS-MC-029 revision): the developer disliked the chain, a strip stretching out of the item. Each bud is now its own
// 28 px droplet (a 30 px target, a 12 px glyph) fanned around the item's right side, like a radial menu: with three buds
// the pencil buds from the item's top-right corner, the link straight right on a short stem, the coffee from the
// bottom-right corner; two sit symmetric about the item's middle. The outer buds stay close to the item's corners rather
// than on a circle, so they never sit beside a neighbouring item, where they would read as its own. Each droplet keeps
// its own neck to the item: a stem along the ray from the item's centre, from just inside the item's edge to the drop.
// Centres are in px from the middle of the item's right edge, chosen so that every target stays right of the edge (the
// icon is never covered) and two targets never overlap.
const RailBudCentres: [number, number][][] = [
    [],
    [[20, 0]],
    [
        [20, -17],
        [20, 17],
    ],
    [
        [18, -25],
        [36, 0],
        [18, 25],
    ],
];
export const RailBudDropPx = 28;
export const RailBudTargetPx = 30;
// The rays start at the item's centre, half an item left of its right edge; a stem starts this far inside the edge, so
// the goo joins it to the item's tile.
const RailItemHalfPx = 18;
const RailBudStemInsetPx = 4;
// Half the height of the fan's fixed box (moltenterm-shell.css), centred on the item.
const RailBudFrameHalfPx = 64;

// A bud's centre (x, y), and its stem: from (stemX, stemY), stemLength px long at stemAngle degrees (clockwise).
export type RailBudSlot = { x: number; y: number; stemX: number; stemY: number; stemLength: number; stemAngle: number };

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

// shift slides the whole fan down (or up, negative) when the item sits by the rail's top or bottom edge: each stem
// still follows the ray from the item's centre to its bud, so the buds keep leaving the item.
export function railBudSlots(count: number, shift = 0): RailBudSlot[] {
    const centres = RailBudCentres[Math.min(Math.max(count, 0), RailBudCentres.length - 1)];
    return centres.map(([x, baseY]) => {
        const y = baseY + shift;
        const ux = (x + RailItemHalfPx) / Math.hypot(x + RailItemHalfPx, y);
        const uy = y / Math.hypot(x + RailItemHalfPx, y);
        const edgeY = (y * RailItemHalfPx) / (x + RailItemHalfPx);
        const stemX = -RailBudStemInsetPx * ux;
        const stemY = edgeY - RailBudStemInsetPx * uy;
        return {
            x,
            y,
            stemX: round1(stemX),
            stemY: round1(stemY),
            stemLength: round1(Math.hypot(x - stemX, y - stemY)),
            stemAngle: round1((Math.atan2(y - stemY, x - stemX) * 180) / Math.PI),
        };
    });
}

// How far right of the item's edge the buds reach: the item's own tooltip goes past it.
export function railBudReachPx(count: number): number {
    const slots = railBudSlots(count);
    if (slots.length === 0) {
        return 0;
    }
    return Math.max(...slots.map((slot) => slot.x)) + RailBudTargetPx / 2;
}

// How far the fan of an item centred at centreY must slide to stay between top and bottom, the rail's edges: at the
// top, the bud above the item would otherwise go under the window's title bar (and macOS's window buttons).
export function railBudShiftPx(count: number, centreY: number, top: number, bottom: number): number {
    const slots = railBudSlots(count);
    if (slots.length === 0) {
        return 0;
    }
    const half = RailBudTargetPx / 2;
    const above = centreY + Math.min(...slots.map((slot) => slot.y)) - half;
    const below = centreY + Math.max(...slots.map((slot) => slot.y)) + half;
    if (above < top) {
        return Math.ceil(top - above);
    }
    if (below > bottom) {
        return -Math.ceil(below - bottom);
    }
    return 0;
}

// How far above and below the item's middle the hover bridge runs: at least the item's own height.
function railBudSpanPx(slots: RailBudSlot[]): number {
    return Math.max(RailItemHalfPx, ...slots.map((slot) => Math.abs(slot.y)));
}

const RailBudGlyphs: Record<RailBudKind, string> = {
    edit: "fa-pencil",
    link: "fa-link",
    coffee: "fa-mug-hot",
};

// The buds that are toggles: they say whether they are pressed.
const RailToggleBuds: Set<RailBudKind> = new Set(["link", "coffee"]);

// Where a bud's tooltip goes: past the whole fan, so it never covers another bud.
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
    const ref = useRef<HTMLSpanElement>(null);
    const [shift, setShift] = useState(0);
    const count = buds.length;
    // Measured as the buds come out (hover or focus of the item), when the item's place in the rail is known.
    useEffect(() => {
        const host = ref.current?.parentElement;
        if (host == null) {
            return;
        }
        const measure = () => {
            const box = ref.current?.getBoundingClientRect();
            if (box == null) {
                return;
            }
            const rail = host.closest(".molten-workspace-rail")?.getBoundingClientRect();
            const centreY = box.top + RailBudFrameHalfPx;
            setShift(railBudShiftPx(count, centreY, rail?.top ?? 0, rail?.bottom ?? window.innerHeight));
        };
        host.addEventListener("pointerenter", measure);
        host.addEventListener("focusin", measure);
        return () => {
            host.removeEventListener("pointerenter", measure);
            host.removeEventListener("focusin", measure);
        };
    }, [count]);
    if (count === 0) {
        return null;
    }
    const slots = railBudSlots(count, shift);
    const place = (index: number) => {
        const slot = slots[index];
        return {
            "--i": index,
            "--x": `${slot.x}px`,
            "--y": `${slot.y}px`,
            "--sx": `${slot.stemX}px`,
            "--sy": `${slot.stemY}px`,
            "--len": `${slot.stemLength}px`,
            "--angle": `${slot.stemAngle}deg`,
        } as React.CSSProperties;
    };
    // The badges have no edge of their own: a ring would cut the necks that join them to the item. The goo drop under
    // each is the same disc, so each bud reads as one droplet with its neck.
    return (
        <span
            ref={ref}
            className="molten-rail-bud"
            data-reduced-motion={reducedMotion ? "" : undefined}
            style={
                {
                    "--molten-rail-bud-reach": `${railBudReachPx(count)}px`,
                    "--molten-rail-bud-span": `${railBudSpanPx(slots)}px`,
                } as React.CSSProperties
            }
        >
            <span className="molten-rail-bud-clip" aria-hidden>
                <span className="molten-rail-bud-goo" style={{ filter: `url(#${RailBudFilterId})` }}>
                    <span className="molten-rail-bud-tile" />
                    {buds.map((bud, index) => (
                        <Fragment key={bud.kind}>
                            <span className="molten-rail-bud-stem" style={place(index)} />
                            <span className="molten-rail-bud-drop" style={place(index)} />
                        </Fragment>
                    ))}
                </span>
            </span>
            <span className="molten-rail-bud-bridge" aria-hidden />
            {buds.map((bud, index) => (
                <button
                    key={bud.kind}
                    type="button"
                    aria-label={bud.label}
                    aria-pressed={RailToggleBuds.has(bud.kind) ? !!bud.pressed : undefined}
                    data-role={`rail-${bud.kind}`}
                    draggable={false}
                    onClick={(e) => bud.onActivate(e.currentTarget)}
                    onMouseEnter={(e) => onHover(bud.tooltip ?? bud.label, e.currentTarget)}
                    onMouseLeave={onLeave}
                    className={cn(
                        "molten-rail-budbtn absolute flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-full",
                        `molten-rail-${bud.kind}`
                    )}
                    style={place(index)}
                >
                    <span className="molten-rail-bud-disc relative inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--molten-rail-bud-fill)] text-12 text-secondary hover:text-primary">
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
