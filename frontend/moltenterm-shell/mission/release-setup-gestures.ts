// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The actions of the notification wavesrv publishes once the release setup's draft has its checks done (#1788): Mark
// ready runs gh pr ready on the developer's click, Open shows the pull request. Registered by every window, so the
// buttons work after a restart.

import { t } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { NotificationGestureResult, registerNotificationGesture } from "../notifications-store";
import { openWebLink } from "../open-web-link";
import { setupPrReady } from "./release-setup-client";

// must match SetupPrReadyGesture and SetupPrOpenGesture in pkg/molten/mission/setupprwatch.go
export const SetupPrReadyGesture = "setup:prready";
export const SetupPrOpenGesture = "setup:propen";

function urlOf(args: Record<string, any>): string {
    return typeof args?.url === "string" ? args.url : "";
}

export async function setupPrReadyGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    const url = urlOf(args);
    if (url === "" || typeof args?.dir !== "string" || args.dir === "") {
        return { ok: false, error: t("mc.setup.prepared.noPrAddress") };
    }
    try {
        await setupPrReady(args.dir, url);
        return { ok: true, resolve: true };
    } catch (e) {
        return { ok: false, error: serverErrorText(e) };
    }
}

export async function setupPrOpenGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    const url = urlOf(args);
    if (url === "") {
        return { ok: false, error: t("mc.setup.prepared.noPrAddress") };
    }
    await openWebLink(url);
    return { ok: true };
}

export function registerSetupPrGestures(): () => void {
    const unregister = [
        registerNotificationGesture(SetupPrReadyGesture, setupPrReadyGesture),
        registerNotificationGesture(SetupPrOpenGesture, setupPrOpenGesture),
    ];
    return () => unregister.forEach((fn) => fn());
}
