// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where a tab keeps its 360 view (FR-SHELL-065, FR-SHELL-066): in its meta, so its manual choice and the fixed zone's
// width survive a restart and any tab can be switched, not only the one shown.

import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { readPlaces } from "./carpet-places";
import { parsePins, type TabPins } from "./pin-model";
import { manualChoice, readFractions } from "./view360-decision";

export const View360MetaKey = "molten:view360";
export const View360FixedPxMetaKey = "molten:view360fixedpx";

// The tab's manual choice (FR-SHELL-066): true on, false off, null when the tab follows the setting.
export function tabManualView360(tab: Tab): boolean {
    return manualChoice((tab?.meta as Record<string, unknown>)?.[View360MetaKey]);
}

export function storedFixedPx(tab: Tab): number {
    const raw = (tab?.meta as Record<string, unknown>)?.[View360FixedPxMetaKey];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

// null drops the manual choice: the tab follows the setting again.
export function setTabView360(tabId: string, choice: boolean): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360MetaKey]: choice == null ? null : choice } as MetaType,
    });
}

// The panels pinned to the fixed zone (FR-SHELL-067, DS-SHELL-118), by block id.
export const View360PinsMetaKey = "molten:view360pins";

export function storedPins(tab: Tab): TabPins {
    return parsePins((tab?.meta as Record<string, unknown>)?.[View360PinsMetaKey]);
}

export function setTabPins(tabId: string, pins: TabPins): Promise<void> {
    const empty = pins == null || Object.keys(pins).length === 0;
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360PinsMetaKey]: empty ? null : pins } as MetaType,
    });
}

export function setTabFixedPx(tabId: string, px: number): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360FixedPxMetaKey]: Math.round(px) } as MetaType,
    });
}

// The view's "360 × N" (FR-SHELL-123): how many panels stay visible beside the fixed zone, next to its pins. A view
// with an N is in 360 view whatever the screen's threshold says; leaving the view forgets it.
export const View360PlacesMetaKey = "molten:view360places";

export function storedPlaces(tab: Tab): number {
    return readPlaces((tab?.meta as Record<string, unknown>)?.[View360PlacesMetaKey]);
}

// What a 360 × N writes, or its Undo gives back, in one meta write: the view's N, its manual choice, its pins and the
// fixed zone's width. A field left undefined is not written.
export type View360PlacesState = {
    places?: number;
    manual?: boolean;
    pins?: TabPins;
    fixedPx?: number;
};

export function writePlacesState(tabId: string, state: View360PlacesState): Promise<void> {
    const meta: Record<string, unknown> = {};
    if (state.places !== undefined) {
        meta[View360PlacesMetaKey] = readPlaces(state.places);
    }
    if (state.manual !== undefined) {
        meta[View360MetaKey] = state.manual == null ? null : state.manual;
    }
    if (state.pins !== undefined) {
        meta[View360PinsMetaKey] = state.pins == null || Object.keys(state.pins).length === 0 ? null : state.pins;
    }
    if (state.fixedPx !== undefined) {
        meta[View360FixedPxMetaKey] = state.fixedPx == null ? null : Math.round(state.fixedPx);
    }
    return RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("tab", tabId), meta: meta as MetaType });
}

// The proportions of the tab's columns as the developer last set them in the normal layout (#1083): the carpet keeps
// them in 360 view and leaving the view gives them back, also after a restart.
export const View360FractionsMetaKey = "molten:view360fractions";

export function storedFractions(tab: Tab): number[] {
    return readFractions((tab?.meta as Record<string, unknown>)?.[View360FractionsMetaKey]);
}

export function setTabFractions(tabId: string, fractions: number[]): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [View360FractionsMetaKey]: fractions.map((f) => Math.round(f * 10000) / 10000) } as MetaType,
    });
}
