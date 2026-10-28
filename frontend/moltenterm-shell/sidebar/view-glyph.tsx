// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view's glyph (DS-SHELL-126, FR-SHELL-081): the icon the developer chose, or its panels' icons separated by a slash,
// up to three ("folder / branch"), never overlapping squares. Tiles, temporary rows and top-row blocks all draw it.

import { WOS } from "@/app/store/global";
import { cn, makeIconClass } from "@/util/util";
import * as jotai from "jotai";
import { AgentStates } from "../agent-state-store";
import { AiIcon } from "../tab-identity";
import { configPaneIcons, paneIcon, viewGlyphIcons, ViewIconMetaKey } from "./view-menu-model";
import { GlobalPin, GlobalPinMetaKey } from "./view-pins-model";
import { ViewPins } from "./view-pins-store";

const glyphAtoms = new Map<string, jotai.Atom<string[]>>();
const NoGlyphAtom = jotai.atom<string[]>([]);

function sameIcons(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// The glyph of a tab's view: its pin's icon when it is pinned everywhere, its own chosen icon, or its panels' icons
// (an agent's glyph where an agent runs).
export function viewGlyphAtom(tabId: string): jotai.Atom<string[]> {
    if (!tabId) {
        return NoGlyphAtom;
    }
    let rtn = glyphAtoms.get(tabId);
    if (rtn != null) {
        return rtn;
    }
    let last: string[] = [];
    rtn = jotai.atom((get) => {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const meta = (tab?.meta ?? {}) as Record<string, any>;
        const gid = meta[GlobalPinMetaKey];
        const pin = gid ? get(ViewPins.getInstance().globalPinsAtom).find((p) => p.id === gid) : null;
        const chosen = pin != null ? pin.icon : meta[ViewIconMetaKey];
        const data = get(AgentStates.getInstance().dataAtom);
        const icons = (tab?.blockids ?? []).map((id) => {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", id)));
            const agent = data?.states?.[id]?.agent;
            return paneIcon(block?.meta, agent ? AiIcon : null);
        });
        const next = viewGlyphIcons(chosen, icons);
        if (!sameIcons(next, last)) {
            last = next;
        }
        return last;
    });
    glyphAtoms.set(tabId, rtn);
    return rtn;
}

// A top-row block's glyph: its pin's icon, else the pin's configuration. Never this workspace's live instance: the
// global row must look the same in every workspace, and an agent running here shows as a corner mark (#1270).
export function topGlyph(pin: GlobalPin): string[] {
    return viewGlyphIcons(pin.icon, configPaneIcons(pin.config));
}

export function ViewGlyph({
    icons,
    small,
    className,
    title,
}: {
    icons: string[];
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
                <span key={`${i}:${icon}`} className={cn("inline-flex items-center", small ? "gap-0.5" : "gap-[3px]")}>
                    {i > 0 ? (
                        <span className={cn("mt-sb-glyph-sl", small ? "text-11" : "text-13")} data-sl="1">
                            /
                        </span>
                    ) : null}
                    <i className={makeIconClass(icon, false, { defaultIcon: "square" })} />
                </span>
            ))}
        </span>
    );
}
