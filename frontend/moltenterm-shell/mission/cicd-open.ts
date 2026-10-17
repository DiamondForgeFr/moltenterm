// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opening the CI/CD panel on one of its tabs from elsewhere (the release run panel's link to the CI it waits on,
// #836). Kept apart from the view so its callers do not load it.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { openMoltentermView } from "../open-view";

export const CicdViewType = "molten-cicd";

export type CicdTabRequest = { tab: "local" | "remote" | "cd" | "jobs"; at: number };

export const CicdTabRequestAtom = atom(null) as PrimitiveAtom<CicdTabRequest>;

export async function openCicdTab(tab: CicdTabRequest["tab"]): Promise<void> {
    globalStore.set(CicdTabRequestAtom, { tab, at: Date.now() });
    await openMoltentermView(CicdViewType);
}
