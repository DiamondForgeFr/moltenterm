// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What MoltenTerm shows when a window starts, mounted by Wave's modals renderer in place of its onboarding dialogs
// (MOLTENTERM-PATCH (#161) in frontend/app/modals/modalsrenderer.tsx). wavesrv lays out the first run before any window
// loads (pkg/wcore/moltenterm_onboarding.go); this hook wires the ways to open it again and docks the panel when
// wavesrv could not. #188 adds its "what's new" notice here, so the Wave file is patched once.

import { atoms, getApi, globalPrimaryTabStartup } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { useEffect } from "react";
import { registerNotificationGesture } from "../moltenterm-shell/notifications-store";
import { clientMeta, findOnboardingPanel } from "./onboarding-client";
import { openFirstRun } from "./onboarding-open";
import { isPending, OnboardingOpenGesture } from "./onboarding-state";

// MoltenTerm's own preload function (emain/preload.ts), typed here so custom.d.ts stays Wave's.
type MoltentermOnboardingApi = {
    onMoltentermGettingStarted?: (callback: () => void) => void;
};

let started = false;

// A first tab that already held panes when the first run started (a data folder whose terms were never accepted)
// gets the panel docked by the window.
async function dockPendingFirstRun(): Promise<void> {
    if (!isPending(clientMeta())) {
        return;
    }
    const found = await findOnboardingPanel(globalStore.get(atoms.workspace)?.oid);
    if (found?.blockid) {
        return;
    }
    await openFirstRun();
}

function startOnce() {
    if (started) {
        return;
    }
    started = true;
    registerNotificationGesture(OnboardingOpenGesture, async () => {
        await openFirstRun();
        return { ok: true };
    });
    (getApi() as unknown as MoltentermOnboardingApi).onMoltentermGettingStarted?.(() => fireAndForget(openFirstRun));
    if (globalPrimaryTabStartup) {
        fireAndForget(dockPendingFirstRun);
    }
}

export function useMoltentermStartup() {
    useEffect(() => {
        startOnce();
    }, []);
}
