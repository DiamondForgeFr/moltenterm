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
import { FaviconMark } from "../favicon/favicon-mark";
import { faviconsAtom, requestFavicons, siteLoadsAtom, type SiteIcon } from "../favicon/favicon-store";
import {
    faviconGlyphOf,
    loadingSiteIcon,
    pageOriginsOf,
    panelFaviconOf,
    siteViewIcon,
    viewSiteOrigins,
} from "../favicon/site-glyph";
import { AiIcon } from "../tab-identity";
import { readScreen, screenGlyphIcons, ScreenMetaKey } from "../view360/screen-glyph";
import { ViewPendingMetaKey } from "../workspace-views/workspace-views-model";
import { pinGlyph } from "./sidebar-blocks";
import { ViewCube } from "./view-cube";
import {
    configPaneIcons,
    configPaneMetas,
    isGlyphCube,
    isGlyphFavicon,
    paneIcon,
    readSiteIconChoice,
    viewGlyphIcons,
    ViewIconMetaKey,
    type GlyphFavicon,
    type GlyphIcon,
} from "./view-menu-model";
import { GlobalPin, GlobalPinMetaKey, PinConfigMetaKey, readPinConfig } from "./view-pins-model";
import { ViewPins } from "./view-pins-store";

const glyphAtoms = new Map<string, jotai.Atom<GlyphIcon[]>>();
const screenGlyphAtoms = new Map<string, jotai.Atom<GlyphIcon[]>>();
const NoGlyphAtom = jotai.atom<GlyphIcon[]>([]);

function sameSite(a: GlyphFavicon, b: GlyphFavicon): boolean {
    return a?.origin === b?.origin && a?.url === b?.url && a?.dark === b?.dark;
}

function sameIcon(a: GlyphIcon, b: GlyphIcon): boolean {
    if (isGlyphCube(a) && isGlyphCube(b)) {
        return (
            a.id === b.id &&
            a.icon === b.icon &&
            a.index === b.index &&
            a.count === b.count &&
            a.shown === b.shown &&
            a.panels.length === b.panels.length &&
            a.panels.every(
                (p, i) => p.id === b.panels[i].id && p.icon === b.panels[i].icon && sameSite(p.site, b.panels[i].site)
            )
        );
    }
    if (isGlyphFavicon(a) && isGlyphFavicon(b)) {
        return sameSite(a, b);
    }
    return a === b;
}

export function sameIcons(a: GlyphIcon[], b: GlyphIcon[]): boolean {
    return a.length === b.length && a.every((x, i) => sameIcon(x, b[i]));
}

// What a tab's view last showed of its site, by tab: while its page loads, the icon shown before stays (#1962).
const lastSiteIcons = new Map<string, GlyphFavicon>();

// The glyph of a tab's view: its pin's icon when it is pinned everywhere, its own chosen icon, the icon of its site when
// it is only one site (#1962), or its screen's marks (an agent's glyph where an agent runs).
export function viewGlyphAtom(tabId: string): jotai.Atom<GlyphIcon[]> {
    return makeGlyphAtom(tabId, glyphAtoms, "view");
}

// The marks of the tab's screen, whatever icon was chosen: what the icon menu's "screen's icons" gives back. A web page
// panel shows its own site's icon there, the view's own icon staying what it is (#1962).
export function screenGlyphAtom(tabId: string): jotai.Atom<GlyphIcon[]> {
    return makeGlyphAtom(tabId, screenGlyphAtoms, "screen");
}

function makeGlyphAtom(
    tabId: string,
    cache: Map<string, jotai.Atom<GlyphIcon[]>>,
    mode: "view" | "screen"
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
        const withChosen = mode === "view";
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const meta = (tab?.meta ?? {}) as Record<string, any>;
        const gid = meta[GlobalPinMetaKey];
        const pin = gid ? get(ViewPins.getInstance().globalPinsAtom).find((p) => p.id === gid) : null;
        const chosen = !withChosen ? null : pin != null ? pin.icon : meta[ViewIconMetaKey];
        const data = get(AgentStates.getInstance().dataAtom);
        const blockIds = tab?.blockids ?? [];
        const known = get(faviconsAtom);
        const metaOf = (id: string) => get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", id)))?.meta;
        const iconOf = (id: string) => {
            const agent = data?.states?.[id]?.agent;
            return paneIcon(metaOf(id), agent ? AiIcon : null);
        };
        const pending = blockIds.length === 0 && meta[ViewPendingMetaKey];
        const panelMetas = pending
            ? configPaneMetas(readPinConfig(meta[PinConfigMetaKey]))
            : blockIds.map((id) => metaOf(id) as Record<string, any>);
        const origins = viewSiteOrigins(panelMetas);
        const chosenSite = readSiteIconChoice(chosen);
        requestFavicons(chosenSite ? [chosenSite] : mode === "screen" ? pageOriginsOf(panelMetas) : origins);
        let marks: GlyphIcon[];
        if (pending) {
            marks = configPaneIcons(readPinConfig(meta[PinConfigMetaKey]));
        } else if (mode === "screen") {
            // A page panel's icon is its site's where the site's icon is known, on the carpet's cube too.
            const siteOf = (id: string) =>
                data?.states?.[id]?.agent == null ? panelFaviconOf(metaOf(id), known) : null;
            const screen = screenGlyphIcons(readScreen(meta[ScreenMetaKey]), blockIds, iconOf, siteOf);
            marks = screen ?? blockIds.map((id) => siteOf(id) ?? iconOf(id));
        } else {
            marks = screenGlyphIcons(readScreen(meta[ScreenMetaKey]), blockIds, iconOf) ?? blockIds.map(iconOf);
        }
        let site: GlyphFavicon = null;
        if (chosen == null) {
            const current = origins.length > 0 ? siteViewIcon(panelMetas, known) : null;
            // The icon preview of the icon menu stands still: only the view itself keeps its icon through a load.
            const loading = withChosen && origins.length > 0 && blockIds.some((id) => get(siteLoadsAtom)[id]);
            const { shown, remembered } = loadingSiteIcon(
                withChosen ? lastSiteIcons.get(tabId) : null,
                current,
                loading
            );
            if (withChosen) {
                if (remembered == null) {
                    lastSiteIcons.delete(tabId);
                } else {
                    lastSiteIcons.set(tabId, remembered);
                }
            }
            site = shown;
        }
        const next = viewGlyphIcons(chosen, site != null ? [site] : marks, (origin) => faviconGlyphOf(origin, known));
        if (!sameIcons(next, last)) {
            last = next;
        }
        return last;
    });
    cache.set(tabId, rtn);
    return rtn;
}

// A top-row block's glyph: its pin's icon, else the site the pin's page is, else the pin's configuration. Never this
// workspace's live instance: the global row must look the same in every workspace, and an agent running here shows as a
// corner mark (#1270).
export function topGlyph(pin: GlobalPin, icons?: Record<string, SiteIcon>): GlyphIcon[] {
    return pinGlyph(pin, icons);
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
                    key={isGlyphCube(icon) ? "cube" : isGlyphFavicon(icon) ? `${i}:fav:${icon.origin}` : `${i}:${icon}`}
                    className={cn("inline-flex items-center", small ? "gap-0.5" : "gap-[3px]")}
                >
                    {i > 0 ? (
                        <span className={cn("mt-sb-glyph-sl", small ? "text-11" : "text-13")} data-sl="1">
                            /
                        </span>
                    ) : null}
                    {isGlyphCube(icon) ? (
                        <ViewCube cube={icon} small={small} />
                    ) : isGlyphFavicon(icon) ? (
                        <FaviconMark url={icon.url} dark={icon.dark} />
                    ) : (
                        <i className={makeIconClass(icon, false, { defaultIcon: "square" })} />
                    )}
                </span>
            ))}
        </span>
    );
}
