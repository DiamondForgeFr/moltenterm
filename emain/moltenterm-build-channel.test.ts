// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BuildChannelEnv, buildChannelFor, RuntimeChannelEnv } from "./moltenterm-build-channel";

// FR-BOSS-010 AC1 (#2246): wavesrv's lock reads the channel Electron main gives it, decided as the window decides it.
describe("the channel Electron main gives wavesrv", () => {
    it("is dev for an unpackaged app, else the launcher's, else the build's", () => {
        expect(buildChannelFor(false, {}, "public")).toBe("dev");
        expect(buildChannelFor(true, { [RuntimeChannelEnv]: "gold" }, "public")).toBe("gold");
        expect(buildChannelFor(true, {}, "public")).toBe("public");
        expect(buildChannelFor(true, {}, "rc")).toBe("rc");
        expect(buildChannelFor(true, {}, "")).toBe("local");
        expect(buildChannelFor(true, {}, "something")).toBe("local");
    });

    it("names the variable wavesrv reads, and wavesrv's launch sets it", () => {
        const go = readFileSync("pkg/molten/buildchannel/buildchannel.go", "utf8");
        expect(go).toContain(`const Env = "${BuildChannelEnv}"`);
        expect(readFileSync("emain/emain-wavesrv.ts", "utf8")).toMatch(
            /envCopy\[BuildChannelEnv\] = currentBuildChannel\(/
        );
    });
});
