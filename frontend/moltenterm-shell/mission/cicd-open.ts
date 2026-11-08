// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Opening the CI/CD panel on one of its tabs from elsewhere (the release run panel's link to the CI it waits on,
// #836). Kept apart from the view so its callers do not load it.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import type { PanelOrigin } from "../app-panel-model";
import { openMoltentermView } from "../open-view";

export const CicdViewType = "molten-cicd";

export type CicdTabRequest = { tab: "local" | "remote" | "cd" | "jobs"; at: number };

export const CicdTabRequestAtom = atom(null) as PrimitiveAtom<CicdTabRequest>;

// From a call to action inside a panel (the release card's link), origin opens the CI/CD panel beside that panel, or
// focuses the view's own one on the tab (#1844).
export async function openCicdTab(tab: CicdTabRequest["tab"], origin?: PanelOrigin): Promise<void> {
    globalStore.set(CicdTabRequestAtom, { tab, at: Date.now() });
    await openMoltentermView(CicdViewType, origin);
}
