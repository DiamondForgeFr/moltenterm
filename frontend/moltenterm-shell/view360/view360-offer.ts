// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The first-time offer (FR-SHELL-066-AC11, AC12, #2180): a view that never was in 360 view, while the developer never
// chose, is not switched when it first goes beyond the screen's column threshold. An inline card in the view asks
// "Switch to the 360 view?" with the numbers of visible panels the chooser offers, Keep the grid, and "Do the same in
// every view"; a change of configuration on a screen the Columns per screen list does not hold then asks once to save
// the screen. Pure rules and the global answer, kept apart from the model and the card so they are tested alone.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { PlaceOption, readPlaces } from "./carpet-places";
import type { ScreenInfo } from "./screen-threshold";
import { AutoMinColumns, overThreshold, View360SettingKey, view360Unchosen } from "./view360-decision";
import { OfferGrid } from "./view360-meta";

export const View360PlacesSettingKey = "moltenterm:view360places";

// What the developer picks on the offer: a number of visible panels (360 × N), or the grid.
export type OfferChoice = number | typeof OfferGrid;

// The numbers on the offer, as the chooser lists them (carpet-places.placeOptions): the offered ones.
export type OfferState = { options: PlaceOption[] };

// A view is asked before it first goes to 360 view while the developer never chose and the view never was in 360 view
// nor answered (hasView360History).
export function offerEligible(rawSetting: unknown, history: boolean): boolean {
    return view360Unchosen(rawSetting) && !history;
}

// The view kept the grid at the offer: while the developer never chose globally, it behaves as Keep the grid. A
// setting chosen since wins.
export function offerKeptGrid(rawSetting: unknown, answer: string): boolean {
    return view360Unchosen(rawSetting) && answer === OfferGrid;
}

// Whether the offer shows now: the view is eligible and has gone beyond the threshold with the columns for a carpet,
// nothing switched it (the safety net did not), and at least one number can apply.
export function offerDue(input: {
    eligible: boolean;
    columnCount: number;
    columnsOver: boolean;
    active: boolean;
    options: PlaceOption[];
}): boolean {
    if (!input.eligible || input.active || !input.columnsOver || input.columnCount < AutoMinColumns) {
        return false;
    }
    return (input.options ?? []).some((o) => o.offered);
}

// What the check "Do the same in every view" stores: Keep the grid, or Automatic with the number of visible panels.
export function everyViewSettings(choice: OfferChoice): Record<string, string> {
    if (choice === OfferGrid) {
        return { [View360SettingKey]: "grid" };
    }
    return { [View360SettingKey]: "auto", [View360PlacesSettingKey]: String(choice) };
}

export async function storeEveryView(choice: OfferChoice): Promise<void> {
    await RpcApi.SetConfigCommand(TabRpcClient, everyViewSettings(choice) as SettingsType);
}

// The stored number of visible panels (a string, as the settings choices are), 1 to 3, or null.
export function readStoredPlaces(raw: unknown): number {
    return readPlaces(typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw);
}

// The number of visible panels a view takes by itself when it first goes beyond the threshold: stored with Automatic
// (the check of the offer, or Settings). Without Automatic chosen there is none.
export function adoptedPlaces(rawSetting: unknown, rawPlaces: unknown): number {
    return rawSetting === "auto" ? readStoredPlaces(rawPlaces) : null;
}

// Whether a view crossed the screen's threshold with this pass (a column was added), the moment a stored number applies.
export function crossedThreshold(prevCount: number, count: number, threshold: number): boolean {
    return (
        prevCount != null &&
        count >= AutoMinColumns &&
        !overThreshold(prevCount, threshold) &&
        overThreshold(count, threshold)
    );
}

// The "Save for this screen?" offer: the screen and the threshold it would be saved with.
export type ScreenOffer = { screen: ScreenInfo; columns: number };
