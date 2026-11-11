// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppChannelEnv, AppDevEnv, wavesrvChannelEnv } from "./moltenterm-build-channel";

// FR-BOSS-010 AC1 (#2246): wavesrv gets the baked channel and whether the app runs unpackaged, and decides the gate
// itself with the window's rule.
describe("what Electron main tells wavesrv about the build", () => {
    it("is the baked channel, never the launcher's, and whether the app is unpackaged", () => {
        expect(wavesrvChannelEnv(true, "public")).toEqual({ [AppChannelEnv]: "public", [AppDevEnv]: "" });
        expect(wavesrvChannelEnv(false, "public")).toEqual({ [AppChannelEnv]: "public", [AppDevEnv]: "1" });
        expect(wavesrvChannelEnv(true, "gold")).toEqual({ [AppChannelEnv]: "gold", [AppDevEnv]: "" });
    });

    it("names the variables wavesrv reads, apart from the build's own MOLTENTERM_BUILD_CHANNEL", () => {
        const go = readFileSync("pkg/molten/buildchannel/buildchannel.go", "utf8");
        expect(go).toContain(`AppChannelEnv = "${AppChannelEnv}"`);
        expect(go).toContain(`AppDevEnv     = "${AppDevEnv}"`);
        expect(AppChannelEnv).not.toBe("MOLTENTERM_BUILD_CHANNEL");
        expect(readFileSync("emain/emain-wavesrv.ts", "utf8")).toMatch(
            /Object\.assign\(envCopy, currentWavesrvChannelEnv\(electron\.app\.isPackaged\)\)/
        );
    });
});
