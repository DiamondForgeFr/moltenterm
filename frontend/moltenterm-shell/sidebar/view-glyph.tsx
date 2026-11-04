// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view's glyph (DS-SHELL-126, FR-SHELL-081): the icon the developer chose, or one mark per screen region separated by
// a slash, up to three ("folder / branch"), never overlapping squares. A grid view has a mark per panel; a view drawn in
// 360 view has its fixed panels' icons and one cube for the carpet (#1823). Tiles, temporary rows and top-row blocks all
// draw it.

import { WOS } from "@/app/store/global";
import { cn, makeIconClass } from "@/util/util";
import * as jotai from "jotai";
import { AgentStates } from "../agent-state-store";
import { AiIcon } from "../tab-identity";
import { readScreen, screenGlyphIcons, ScreenMetaKey } from "../view360/screen-glyph";
import { ViewPendingMetaKey } from "../workspace-views/workspace-views-model";
import { pinGlyph } from "./sidebar-blocks";
import { ViewCube } from "./view-cube";
import {
    configPaneIcons,
    isGlyphCube,
    paneIcon,
    viewGlyphIcons,
    ViewIconMetaKey,
    type GlyphIcon,
} from "./view-menu-model";
import { GlobalPin, GlobalPinMetaKey, PinConfigMetaKey, readPinConfig } from "./view-pins-model";
import { ViewPins } from "./view-pins-store";

const glyphAtoms = new Map<string, jotai.Atom<GlyphIcon[]>>();
const screenGlyphAtoms = new Map<string, jotai.Atom<GlyphIcon[]>>();
const NoGlyphAtom = jotai.atom<GlyphIcon[]>([]);

function sameIcon(a: GlyphIcon, b: GlyphIcon): boolean {
    if (isGlyphCube(a) && isGlyphCube(b)) {
        return (
            a.id === b.id &&
            a.icon === b.icon &&
            a.index === b.index &&
            a.count === b.count &&
            a.shown === b.shown &&
            a.panels.length === b.panels.length &&
            a.panels.every((p, i) => p.id === b.panels[i].id && p.icon === b.panels[i].icon)
        );
    }
    return a === b;
}

export function sameIcons(a: GlyphIcon[], b: GlyphIcon[]): boolean {
    return a.length === b.length && a.every((x, i) => sameIcon(x, b[i]));
}

// The glyph of a tab's view: its pin's icon when it is pinned everywhere, its own chosen icon, or its screen's marks
// (an agent's glyph where an agent runs).
export function viewGlyphAtom(tabId: string): jotai.Atom<GlyphIcon[]> {
    return makeGlyphAtom(tabId, glyphAtoms, true);
}

// The marks of the tab's screen, whatever icon was chosen: what the icon menu's "screen's icons" gives back.
export function screenGlyphAtom(tabId: string): jotai.Atom<GlyphIcon[]> {
    return makeGlyphAtom(tabId, screenGlyphAtoms, false);
}

function makeGlyphAtom(
    tabId: string,
    cache: Map<string, jotai.Atom<GlyphIcon[]>>,
    withChosen: boolean
): jotai.Atom<GlyphIcon[]> {
    if (!tabId) {
        return NoGlyphAtom;
    }
    let rtn = cache.get(tabId);
    if (rtn != null) {
        return rtn;
    }
    let last: GlyphIcon[] = [];
    rtn = jotai.atom((get) => {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const meta = (tab?.meta ?? {}) as Record<string, any>;
        const gid = meta[GlobalPinMetaKey];
        const pin = gid ? get(ViewPins.getInstance().globalPinsAtom).find((p) => p.id === gid) : null;
        const chosen = !withChosen ? null : pin != null ? pin.icon : meta[ViewIconMetaKey];
        const data = get(AgentStates.getInstance().dataAtom);
        const blockIds = tab?.blockids ?? [];
        const iconOf = (id: string) => {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", id)));
            const agent = data?.states?.[id]?.agent;
            return paneIcon(block?.meta, agent ? AiIcon : null);
        };
        // A new workspace's view not opened yet (FR-SHELL-092) shows the panels it will open.
        const icons =
            blockIds.length === 0 && meta[ViewPendingMetaKey]
                ? configPaneIcons(readPinConfig(meta[PinConfigMetaKey]))
                : (screenGlyphIcons(readScreen(meta[ScreenMetaKey]), blockIds, iconOf) ?? blockIds.map(iconOf));
        const next = viewGlyphIcons(chosen, icons);
        if (!sameIcons(next, last)) {
            last = next;
        }
        return last;
    });
    cache.set(tabId, rtn);
    return rtn;
}

// A top-row block's glyph: its pin's icon, else the pin's configuration. Never this workspace's live instance: the
// global row must look the same in every workspace, and an agent running here shows as a corner mark (#1270).
export function topGlyph(pin: GlobalPin): GlyphIcon[] {
    return pinGlyph(pin);
}

export function ViewGlyph({
    icons,
    small,
    className,
    title,
}: {
    icons: GlyphIcon[];
    small?: boolean;
    className?: string;
    title?: string;
}) {
    return (
        <span
            className={cn(
                "mt-sb-glyph inline-flex min-w-0 shrink-0 items-center",
                small ? "gap-0.5 text-icon-14" : "gap-[3px] text-icon-16",
                className
            )}
            title={title}
            data-testid="sidebar-glyph"
            aria-hidden
        >
            {icons.map((icon, i) => (
                <span
                    key={isGlyphCube(icon) ? "cube" : `${i}:${icon}`}
                    className={cn("inline-flex items-center", small ? "gap-0.5" : "gap-[3px]")}
                >
                    {i > 0 ? (
                        <span className={cn("mt-sb-glyph-sl", small ? "text-11" : "text-13")} data-sl="1">
                            /
                        </span>
                    ) : null}
                    {isGlyphCube(icon) ? (
                        <ViewCube cube={icon} small={small} />
                    ) : (
                        <i className={makeIconClass(icon, false, { defaultIcon: "square" })} />
                    )}
                </span>
            ))}
        </span>
    );
}
