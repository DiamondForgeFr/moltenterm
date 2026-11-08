// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The site permission questions of a browser panel (#663). Kept apart from the bar so the panel holds the questions
// without loading the bar's code, which only arrives once a page asks (NFR-PERF-003, bundle.initialJsMB).

import { getApi } from "@/app/store/global";
import { DecisionDismiss } from "./site-permission";
import { TabAsks } from "./tab-asks";

export type SiteAsk = { requestid: string; site: string; kinds: string[] };

type SitePermissionApi = { moltentermSitePermissionAnswer?: (requestId: string, decision: string) => void };

export function isSiteAsk(value: any): value is SiteAsk {
    return (
        value != null &&
        typeof value.requestid === "string" &&
        typeof value.site === "string" &&
        Array.isArray(value.kinds) &&
        value.kinds.every((k: unknown) => typeof k === "string")
    );
}

export class SitePermissionModel extends TabAsks<SiteAsk> {
    answer(requestId: string, decision: string): void {
        this.remove(requestId);
        (getApi() as SitePermissionApi).moltentermSitePermissionAnswer?.(requestId, decision);
    }

    // A closed tab refuses what its pages asked.
    forgetTab(tabId: string): void {
        for (const ask of this.asksOf(tabId)) {
            this.answer(ask.requestid, DecisionDismiss);
        }
    }
}
