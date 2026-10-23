// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Approving a project's commands without running them (DS-MC-005, #1017): the notification of a run refused from a
// terminal, and the Reviews line of the agent that was refused, open the trust sheet in approve-only mode. The sheet
// reads the folder's commands again, so the developer trusts what a run would run now; Trust records it and starts
// nothing, and wavesrv then closes the notification and tells the refused agents.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { t } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import {
    MoltentermNotifications,
    NotificationGestureResult,
    registerNotificationGesture,
} from "../notifications-store";
import { pathBaseName } from "../workspace-project";
import { missionTrust, missionUntrusted } from "./mission-client";
import { UntrustedInfo } from "./mission-model";
import { TrustPrompt } from "./runs-view";
import { trustAskOf, TrustReviewGesture } from "./trust-approval-model";

type PendingApproval = {
    dir: string;
    info: UntrustedInfo;
    busy: boolean;
    trust: () => void;
    cancel: () => void;
};

export class TrustApprovalModel {
    private static instance: TrustApprovalModel = null;

    // The sheet this window shows, at most one.
    pendingAtom = atom(null) as PrimitiveAtom<PendingApproval>;

    private constructor() {}

    static getInstance(): TrustApprovalModel {
        if (TrustApprovalModel.instance == null) {
            TrustApprovalModel.instance = new TrustApprovalModel();
        }
        return TrustApprovalModel.instance;
    }

    // Opens the sheet for the folder's commands; resolves once the developer trusted them or closed the sheet.
    async review(dir: string): Promise<NotificationGestureResult> {
        if (!dir) {
            return { ok: false, error: t("mc.trust.error.noProject") };
        }
        let info: UntrustedInfo;
        try {
            info = await missionUntrusted(dir);
        } catch (e) {
            return { ok: false, error: serverErrorText(e) };
        }
        if (info == null) {
            // Trusted meanwhile (from another window, or a run started from a panel).
            return { ok: true, resolve: true };
        }
        globalStore.get(this.pendingAtom)?.cancel();
        return new Promise((resolve) => {
            const done = (result: NotificationGestureResult) => {
                if (globalStore.get(this.pendingAtom)?.info === info) {
                    globalStore.set(this.pendingAtom, null);
                }
                resolve(result);
            };
            const pending: PendingApproval = {
                dir,
                info,
                busy: false,
                cancel: () => done({ ok: true }),
                trust: () => {
                    const current = globalStore.get(this.pendingAtom);
                    if (current == null || current.busy) {
                        return;
                    }
                    globalStore.set(this.pendingAtom, { ...current, busy: true });
                    missionTrust(dir, info.hash).then(
                        () => done({ ok: true, resolve: true }),
                        (e) => done({ ok: false, error: serverErrorText(e) })
                    );
                },
            };
            globalStore.set(this.pendingAtom, pending);
        });
    }
}

export function reviewProjectCommands(dir: string): Promise<NotificationGestureResult> {
    return TrustApprovalModel.getInstance().review(dir);
}

// The folder whose commands wait because the agent in blockId was refused a run; "" when none.
export function useTrustAsk(blockId: string): string {
    const entries = useAtomValue(MoltentermNotifications.getInstance().entriesAtom, { store: globalStore });
    return useMemo(() => trustAskOf(entries, blockId), [entries, blockId]);
}

async function trustReviewGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    return reviewProjectCommands(typeof args.dir === "string" ? args.dir : "");
}

// Mounted once per window (with the notification center): the approve-only sheet and the notification's action.
export function TrustApprovalHost() {
    const model = TrustApprovalModel.getInstance();
    const pending = useAtomValue(model.pendingAtom, { store: globalStore });
    useEffect(() => registerNotificationGesture(TrustReviewGesture, trustReviewGesture), []);
    useEffect(() => () => globalStore.get(model.pendingAtom)?.cancel(), [model]);
    if (pending == null) {
        return null;
    }
    return (
        <TrustPrompt
            projectName={pathBaseName(pending.dir)}
            dir={pending.dir}
            info={pending.info}
            onTrust={pending.trust}
            onCancel={pending.cancel}
            busy={pending.busy}
            approveOnly
        />
    );
}
