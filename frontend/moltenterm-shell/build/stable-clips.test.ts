// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clipOutput, moltentermStableClips } from "./stable-clips";

const Root = mkdtempSync(join(tmpdir(), "mt-clips-"));
afterAll(() => rmSync(Root, { recursive: true, force: true }));

describe("a character's clips keep their names in the build (FR-BOSS-007)", () => {
    it("emits the clips of a character together, under their own names", () => {
        expect(clipOutput("/repo/frontend/moltenterm-shell/boss/portrait/brokk/listening-to-thinking.webm?url")).toEqual({
            fileName: "assets/portrait/brokk/listening-to-thinking.webm",
            file: "/repo/frontend/moltenterm-shell/boss/portrait/brokk/listening-to-thinking.webm",
        });
        expect(clipOutput("/r/portrait/notulia/listening.webm")?.fileName).toBe("assets/portrait/notulia/listening.webm");
    });

    it("reads a Windows path as well", () => {
        expect(clipOutput("C:\\repo\\boss\\portrait\\brokk\\thinking.webm?url")?.fileName).toBe(
            "assets/portrait/brokk/thinking.webm"
        );
    });

    it("leaves every other module to Vite", () => {
        expect(clipOutput("/repo/frontend/app/asset/logo.svg")).toBeNull();
        expect(clipOutput("/repo/frontend/moltenterm-shell/boss/portrait/brokk/brokk.jpg")).toBeNull();
        expect(clipOutput("/repo/frontend/intro/promo.webm")).toBeNull();
        expect(clipOutput("/repo/frontend/moltenterm-shell/boss/portrait/brokk.ts")).toBeNull();
        expect(clipOutput("")).toBeNull();
        expect(clipOutput(undefined)).toBeNull();
    });

    it("emits every clip under its own file name, the ones that hold the same bytes included", () => {
        const folder = join(Root, "boss", "portrait", "brokk");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "listening.nod.webm"), "same bytes");
        writeFileSync(join(folder, "speaking.nod.webm"), "same bytes");
        const emitted: { fileName: string; source: Buffer }[] = [];
        const plugin = moltentermStableClips();
        const context = {
            emitFile: (asset: { type: "asset"; fileName: string; source: Buffer }) => {
                emitted.push(asset);
                return `ref${emitted.length}`;
            },
        };
        const first = plugin.load.call(context, `${join(folder, "listening.nod.webm")}?url`);
        const second = plugin.load.call(context, `${join(folder, "speaking.nod.webm")}?url`);
        expect(emitted.map((asset) => asset.fileName)).toEqual([
            "assets/portrait/brokk/listening.nod.webm",
            "assets/portrait/brokk/speaking.nod.webm",
        ]);
        expect(emitted.every((asset) => asset.source.toString() === "same bytes")).toBe(true);
        expect(first).toBe("export default import.meta.ROLLUP_FILE_URL_ref1;");
        expect(second).toBe("export default import.meta.ROLLUP_FILE_URL_ref2;");
        expect(plugin.load.call(context, join(Root, "other.svg"))).toBeNull();
    });

    it("works in the build only, where the assets are emitted, and before Vite's own asset handling", () => {
        const plugin = moltentermStableClips();
        expect(plugin.apply).toBe("build");
        expect(plugin.enforce).toBe("pre");
    });
});
