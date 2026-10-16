// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The site permission bar of the browser panel (#663): a page asks for the camera, the microphone, the location or
// notifications, and the tab asks the user in the slot of the other bars. Allow and Block are remembered for the site
// (browser:sitepermissions); Escape refuses this time only. Like the agent permission bar, it never takes the focus,
// and a click right after it appears is ignored, so a click meant for the page cannot answer it.

import { Button } from "@/app/element/button";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useRef } from "react";
import { useT } from "../i18n/i18n";
import { suiteIcon } from "../suite/suite-icons";
import { answerTooSoon } from "./browser-agent";
import {
    DecisionAllow,
    DecisionBlock,
    DecisionDismiss,
    KindCamera,
    KindLocation,
    KindMicrophone,
    sitePermissionWhatKey,
} from "./site-permission";

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

// The questions of one panel, per browser tab, oldest first; in memory only.
export class SitePermissionModel {
    asksAtom = atom({}) as PrimitiveAtom<Record<string, SiteAsk[]>>;

    add(tabId: string, ask: SiteAsk): void {
        const all = globalStore.get(this.asksAtom);
        const list = all[tabId] ?? [];
        if (list.some((a) => a.requestid === ask.requestid)) {
            return;
        }
        globalStore.set(this.asksAtom, { ...all, [tabId]: [...list, ask] });
    }

    // The question is gone: answered here, or settled by main (another answer, the timeout, the page closed).
    remove(requestId: string): void {
        const all = globalStore.get(this.asksAtom);
        let changed = false;
        const next: Record<string, SiteAsk[]> = {};
        for (const [tabId, list] of Object.entries(all)) {
            const kept = list.filter((a) => a.requestid !== requestId);
            changed = changed || kept.length !== list.length;
            if (kept.length > 0) {
                next[tabId] = kept;
            }
        }
        if (changed) {
            globalStore.set(this.asksAtom, next);
        }
    }

    current(tabId: string): SiteAsk {
        return globalStore.get(this.asksAtom)[tabId]?.[0] ?? null;
    }

    answer(requestId: string, decision: string): void {
        this.remove(requestId);
        (getApi() as SitePermissionApi).moltentermSitePermissionAnswer?.(requestId, decision);
    }

    // A closed tab refuses what its pages asked.
    forgetTab(tabId: string): void {
        for (const ask of globalStore.get(this.asksAtom)[tabId] ?? []) {
            this.answer(ask.requestid, DecisionDismiss);
        }
    }
}

function kindIcon(kinds: string[]) {
    if (kinds.includes(KindCamera)) {
        return suiteIcon("camera");
    }
    if (kinds.includes(KindMicrophone)) {
        return suiteIcon("microphone");
    }
    if (kinds.includes(KindLocation)) {
        return suiteIcon("location");
    }
    return suiteIcon("notifications");
}

export function SitePermissionBar({ permissions, tabId }: { permissions: SitePermissionModel; tabId: string }) {
    const t = useT();
    const asks = useAtomValue(permissions.asksAtom);
    const shown = useRef({ requestId: "", at: 0 });
    const ask = asks[tabId]?.[0] ?? null;
    if (ask != null && shown.current.requestId !== ask.requestid) {
        shown.current = { requestId: ask.requestid, at: Date.now() };
    }
    if (ask == null) {
        return null;
    }
    const click = (decision: string) => {
        if (answerTooSoon(shown.current.at, Date.now())) {
            return;
        }
        permissions.answer(ask.requestid, decision);
    };
    const Icon = kindIcon(ask.kinds);
    return (
        <div
            role="region"
            aria-label={t("browser.sitePermission.aria")}
            data-testid="site-permission-bar"
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                e.stopPropagation();
                permissions.answer(ask.requestid, DecisionDismiss);
            }}
            className="molten-browser-sitepermission flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-2 py-1.5 text-12"
        >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-4 bg-accent/15 text-accent">
                <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden={true} />
            </span>
            <div aria-live="polite" className="flex min-w-[150px] flex-1 items-baseline gap-2 truncate">
                <span className="max-w-full shrink-0 truncate text-primary">
                    {t("browser.sitePermission.title", { site: ask.site, what: t(sitePermissionWhatKey(ask.kinds)) })}
                </span>
                <span className="min-w-0 truncate text-secondary">{t("browser.sitePermission.detail")}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <button
                    type="button"
                    data-testid="site-permission-block"
                    onClick={() => click(DecisionBlock)}
                    className="h-6 cursor-pointer rounded-4 border border-border px-2.5 text-primary hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--mt-focus-ring)"
                >
                    {t("browser.sitePermission.block")}
                </button>
                <Button
                    className="!h-6 !px-2.5 !text-12"
                    data-testid="site-permission-allow"
                    onClick={() => click(DecisionAllow)}
                >
                    {t("browser.sitePermission.allow")}
                </Button>
            </div>
        </div>
    );
}
