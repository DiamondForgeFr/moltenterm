// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view made ahead of time (the hot spare) loads the client when it is made and hears none of its changes until a tab
// is given to it. The contexts and the top row of each context live in the client, so a workspace made in a context
// just created (FR-SHELL-159) would show the contexts and the tiles of the moment the spare was made (#2526).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WaveSource = readFileSync("frontend/wave.ts", "utf8");
const InitStart = WaveSource.indexOf("async function initWave(");
const InitWave = WaveSource.slice(InitStart, WaveSource.indexOf("\nasync function ", InitStart + 1));

describe("a view given a tab reads the client again (#2526)", () => {
    it("reloads the client in initWave instead of taking the copy it loaded when it was made", () => {
        expect(InitWave).toContain('WOS.reloadWaveObject<Client>(WOS.makeORef("client", initOpts.clientId))');
        expect(InitWave).not.toContain('WOS.loadAndPinWaveObject<Client>(WOS.makeORef("client"');
    });
});
