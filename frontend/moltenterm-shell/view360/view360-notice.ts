// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first automatic switch to 360 view is announced once (FR-SHELL-066-AC10, #1654): a toast says what happened,
// with "Keep the grid" and "Use 360", and the answer is stored in the 360 view setting, so it never asks again. Never
// a dialog (no surprise, #758). Dismissed without an answer, it may come back at a later switch, once per session.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "../i18n/i18n";
import { dismissToast, showToast } from "../toast-store";
import { View360SettingKey, view360Unchosen } from "./view360-decision";

export const View360NoticeToastId = "view360-first-switch";

export type View360NoticeChoice = "grid" | "auto";

export const View360NoticeState = { shown: false };

export function resetView360Notice(): void {
    View360NoticeState.shown = false;
}

// Whether a switch just made by the automatic decision is announced: the view went to 360 view, the developer never
// chose, and the notice has not shown in this session.
export function shouldShowView360Notice(rawSetting: unknown, active: boolean, shown: boolean): boolean {
    return active && !shown && view360Unchosen(rawSetting);
}

export function view360NoticeText() {
    return {
        title: t("view360.notice.title"),
        message: t("view360.notice.message"),
        actionLabels: { grid: t("view360.notice.keepGrid"), auto: t("view360.notice.use360") },
    };
}

export async function storeView360Choice(choice: View360NoticeChoice): Promise<void> {
    await RpcApi.SetConfigCommand(TabRpcClient, { [View360SettingKey]: choice } as SettingsType);
}

// Shows the notice once per session; `onChoose` runs with the answer before it is stored.
export function showView360Notice(onChoose: (choice: View360NoticeChoice) => void): boolean {
    if (View360NoticeState.shown) {
        return false;
    }
    View360NoticeState.shown = true;
    const answer = (choice: View360NoticeChoice) => async () => {
        dismissToast(View360NoticeToastId);
        onChoose(choice);
        await storeView360Choice(choice);
    };
    const text = view360NoticeText();
    showToast({
        id: View360NoticeToastId,
        kind: "info",
        title: text.title,
        message: text.message,
        text: view360NoticeText,
        stays: true,
        question: true,
        actions: [
            { id: "grid", label: text.actionLabels.grid, run: answer("grid") },
            { id: "auto", label: text.actionLabels.auto, run: answer("auto") },
        ],
    });
    return true;
}
