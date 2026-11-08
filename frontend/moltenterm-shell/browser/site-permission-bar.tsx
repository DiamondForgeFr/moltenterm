// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The site permission bar of the browser panel (#663): a page asks for the camera, the microphone, the location or
// notifications, and the tab asks the user in the slot of the other bars. Allow and Block are remembered for the site
// (browser:sitepermissions); Escape refuses this time only. Like the agent permission bar, it never takes the focus,
// and a click right after it appears is ignored, so a click meant for the page cannot answer it.

import { Button } from "@/app/element/button";
import { useAtomValue } from "jotai";
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
import { SitePermissionModel } from "./site-permission-store";

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
                    className="h-6 cursor-pointer rounded-4 border border-border px-2.5 text-primary hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)"
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
