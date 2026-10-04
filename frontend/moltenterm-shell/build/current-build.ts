// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The build that runs, as the status bar and the About panel name it (FR-SHELL-008, FR-REL-001).

import { getApi } from "@/app/store/global";
import type { MoltentermBuildInfo } from "./build-info";
import { BuildIdentity, makeBuildIdentity } from "./build-identity";

export function readBuildInfo(): MoltentermBuildInfo {
    return typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
}

// The channel Mission Control's launcher set for a gold copy, if any.
export function readRuntimeChannel(): string {
    return getApi().getEnv("MOLTENTERM_CHANNEL");
}

export function currentBuildIdentity(version: string): BuildIdentity {
    return makeBuildIdentity(readBuildInfo(), {
        isDev: getApi().getIsDev(),
        runtimeChannel: readRuntimeChannel(),
        version,
    });
}
