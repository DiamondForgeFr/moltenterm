// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import { MoltentermSafeModeArg, MoltentermSafeModeVarName } from "../frontend/util/moltenterm-safemode";

// Runs when the module loads, before wavesrv and the windows start: they read safe mode from the environment
// (renderers through the get-env IPC), so the relaunch argument is turned into the variable here.
if (process.argv.includes(MoltentermSafeModeArg)) {
    process.env[MoltentermSafeModeVarName] = "1";
}

export function isMoltentermSafeMode(): boolean {
    return process.env[MoltentermSafeModeVarName] === "1";
}

function relaunchMoltenterm(safeMode: boolean) {
    const args = process.argv.slice(1).filter((arg) => arg !== MoltentermSafeModeArg);
    if (safeMode) {
        args.push(MoltentermSafeModeArg);
    } else {
        // The relaunched app inherits this environment: a safe mode set by the variable must not come back.
        delete process.env[MoltentermSafeModeVarName];
    }
    electron.app.relaunch({ args });
    electron.app.quit();
}

export function makeMoltentermSafeModeMenuItem(): electron.MenuItemConstructorOptions {
    if (isMoltentermSafeMode()) {
        return { label: "Restart Normally", click: () => relaunchMoltenterm(false) };
    }
    return { label: "Restart in Safe Mode", click: () => relaunchMoltenterm(true) };
}
