// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atoms, globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { useMemo, useState } from "react";
import { SettingsScreen } from "../../moltenterm-shell/settings/settings-screen";
import { ToastStack } from "../../moltenterm-shell/toast-stack";

type Request = { settings: Record<string, unknown>; resolve: () => void; reject: () => void };

// The real Settings screen and RPC boundary, with disposable in-memory configuration and controllable requests.
// The browser check holds a request across a section change, then confirms both persisted data and the remount.
export function SettingsSliderPreview() {
    const [open, setOpen] = useState(true);
    useMemo(() => {
        const requests: Request[] = [];
        const saved: Record<string, unknown> = { "window:opacity": 0.9 };
        const calls: Record<string, unknown>[] = [];
        const publish = () => globalStore.set(atoms.fullConfigAtom, { settings: { ...saved } } as FullConfigType);
        publish();
        RpcApi.SetConfigCommand = async (_client, settings) => {
            calls.push({ ...settings });
            await new Promise<void>((resolve, reject) => {
                requests.push({
                    settings,
                    resolve: () => {
                        Object.entries(settings).forEach(([key, value]) => {
                            if (value == null) delete saved[key];
                            else saved[key] = value;
                        });
                        publish();
                        resolve();
                    },
                    reject: () => reject(new Error("Fixture: persistence unavailable")),
                });
            });
        };
        (globalThis as any).settingsSliderFixture = {
            requests,
            calls,
            saved,
            close: () => setOpen(false),
            reopen: () => setOpen(true),
            resolve: () => requests.shift()?.resolve(),
            reject: () => requests.shift()?.reject(),
        };
    }, []);
    return (
        <div className="h-[800px] w-full">
            {open ? (
                <SettingsScreen blockId="slider-fixture" files={[]} onOpenFile={() => {}} initialSection="appearance" />
            ) : null}
            <ToastStack onOpenCenter={() => {}} />
        </div>
    );
}
