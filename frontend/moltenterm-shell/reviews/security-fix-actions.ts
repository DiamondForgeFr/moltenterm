// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the window does for the fix of a shared security block (FR-REV-036 AC10, AC13, #2589): records the developer's
// answer to the first-time ask, and stops a fix. The panel's block (#2591) calls them from its buttons; the notification's
// Stop is the gesture below. Both write through the same calls the rest of the window uses, which wavesrv checks.

import { ClientModel } from "@/app/store/client-model";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "../i18n/i18n";
import type { NotificationGestureResult } from "../notifications-store";
import { stopSecurityFix } from "../review/review-client";
import { SecurityFixAnswer, securityFixConsentWrites, SecurityFixStopGesture } from "./security-fix-model";

// The developer's answer to the first-time ask: the confirmation wavesrv requires first (in the client's meta), then the
// setting. "always" starts the fix on its own from then on; "ask" says it only offers it. A terminal can write neither,
// and an agent that writes the setting by hand gets no consent.
export async function recordSecurityFixAnswer(answer: SecurityFixAnswer, now: number = Date.now()): Promise<void> {
    const { clientMeta, settings } = securityFixConsentWrites(answer, now);
    const clientId = ClientModel.getInstance().clientId;
    if (clientId != null) {
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("client", clientId), meta: clientMeta as MetaType });
    }
    await RpcApi.SetConfigCommand(TabRpcClient, settings as SettingsType);
}

// The notification's Stop (FR-REV-036 AC13): the same Stop as the block's and the card's.
export async function securityFixStopGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    const dir = typeof args?.dir === "string" ? args.dir : "";
    const fingerprint = typeof args?.fingerprint === "string" ? args.fingerprint : "";
    if (dir === "" || fingerprint === "") {
        return { ok: false, error: t("agentChoice.noSecurityFix") };
    }
    const result = await stopSecurityFix({ dir, fingerprint });
    return result.status === "stopped"
        ? { ok: true, resolve: true }
        : { ok: false, error: t("agentChoice.noSecurityFix") };
}

export { SecurityFixStopGesture };
