// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    BrokkDeclaration,
    BrokkManifest,
    BrokkPortrait,
    clipNames,
    clipsFolder,
    makeBrokkDeclaration,
    packageState,
} from "./brokk-portrait";
import Manifest from "./portrait/brokk/brokk-manifest.json";

const Folder = join(__dirname, "portrait", "brokk");

// A stylesheet without its comments, which explain the rules in words the patterns below would catch.
function css(file: string): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Brokk's declaration (FR-BOSS-007, AC1)", () => {
    const declaration = makeBrokkDeclaration(Manifest as BrokkManifest, "/clips", "/brokk.jpg");

    it("is a plain object for the package's portrait: the still, the folder of the clips, the transitions and the gestures", () => {
        expect(Object.keys(declaration).sort()).toEqual(["idles", "loops", "src", "transitions"]);
        expect(declaration.src).toBe("/brokk.jpg");
        expect(declaration.loops).toBe("/clips");
    });

    it("declares the transitions of the manifest, and none between two poses that look alike", () => {
        expect(declaration.transitions).toEqual([
            "listening>thinking",
            "speaking>thinking",
            "thinking>listening",
            "thinking>speaking",
            "listening>offline",
            "speaking>offline",
            "offline>listening",
            "offline>speaking",
            "thinking>offline",
            "offline>thinking",
        ]);
        expect(declaration.transitions).not.toContain("listening>speaking");
        expect(declaration.transitions).not.toContain("speaking>listening");
    });

    it("declares the gestures with their weights: the random ones weigh, the ones asked wait to be asked", () => {
        expect(declaration.idles).toEqual({
            listening: [
                { name: "blink", weight: 4 },
                { name: "nod" },
                { name: "doubtful", onDemand: true },
                { name: "frown", onDemand: true },
                { name: "smile", onDemand: true },
                { name: "call", onDemand: true },
            ],
            speaking: [{ name: "blink", weight: 2 }, { name: "nod" }],
        });
    });

    it("names the resting pose `rest` in MoltenTerm and `offline` for the package, which knows no other (version 0.1.0)", () => {
        expect(packageState("rest")).toBe("offline");
        expect(packageState("listening")).toBe("listening");
        expect(packageState("thinking")).toBe("thinking");
        expect(packageState("speaking")).toBe("speaking");
        expect(Manifest.states).toContain("rest");
        expect(JSON.stringify(declaration)).not.toContain("rest");
    });

    it("leaves out what the package cannot play rather than failing: a state or a gesture it does not know", () => {
        const odd: BrokkManifest = {
            ...(Manifest as BrokkManifest),
            transitions: ["listening>flying", "listening>thinking"],
            idles: { flying: [{ name: "flap" }], listening: [{ name: "blink", weight: 1 }] },
        };
        const made = makeBrokkDeclaration(odd, "/c", "/s.jpg");
        expect(made.transitions).toEqual(["listening>thinking"]);
        expect(Object.keys(made.idles)).toEqual(["listening"]);
    });
});

describe("Brokk's clips", () => {
    const wanted = clipNames(makeBrokkDeclaration(Manifest as BrokkManifest, "/c", "/s.jpg"));
    const found = readdirSync(Folder)
        .filter((file) => file.endsWith(".webm"))
        .map((file) => file.replace(/\.webm$/, ""))
        .sort();

    it("are all in the folder, under the names the package looks for, and nothing else is", () => {
        expect([...wanted].sort()).toEqual(found);
        expect(found).toHaveLength(22);
    });

    it("are each under 1 MB, and under 11 MB together (480 x 480, 16 fps, validated by DiamondForge)", () => {
        const sizes = found.map((name) => statSync(join(Folder, `${name}.webm`)).size);
        for (const size of sizes) {
            expect(size).toBeLessThan(1_000_000);
        }
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(11_000_000);
    });

    it("are found by the build, which hands the declaration one folder to read them from", () => {
        expect(BrokkPortrait.loops).toBeTruthy();
        expect(BrokkPortrait.loops).toMatch(/portrait\/brokk$/);
    });

    it("have one folder when their URLs share it, and none otherwise, so the still plays the part", () => {
        expect(clipsFolder({ a: "/x/brokk/a.webm", b: "/x/brokk/b.webm" })).toBe("/x/brokk");
        expect(clipsFolder({ a: "/x/brokk/a.webm", b: "/y/brokk/b.webm" })).toBeUndefined();
        expect(clipsFolder({})).toBeUndefined();
        expect(clipsFolder({ a: "data:video/webm;base64,AAAA" })).toBeUndefined();
        expect(clipsFolder({ a: "file:///app/assets/portrait/brokk/a.webm" })).toBe(
            "file:///app/assets/portrait/brokk"
        );
    });

    it("hold the resting pose's under the package's name, not the manifest's: the package would not find those", () => {
        expect(existsSync(join(Folder, "rest.webm"))).toBe(false);
        expect(existsSync(join(Folder, "offline.webm"))).toBe(true);
        for (const state of ["listening", "thinking", "speaking"]) {
            expect(existsSync(join(Folder, `offline-to-${state}.webm`))).toBe(true);
        }
        for (const state of ["listening", "thinking", "speaking"]) {
            expect(existsSync(join(Folder, `${state}-to-offline.webm`))).toBe(true);
        }
    });
});

describe("Brokk's framing", () => {
    it("is the manifest's: the head at 50 % / 14 % and the bubble's zoom of 2.2, held in one place", () => {
        const framing = css("boss-portrait.css");
        expect(Manifest.head).toEqual({ x: 0.5, y: 0.14, bubbleZoom: 2.2 });
        expect(framing).toContain(`--mt-boss-head-scale: ${Manifest.head.bubbleZoom};`);
        expect(framing).toContain(
            `--mt-boss-head-origin: ${Manifest.head.x * 100}% ${Math.round(Manifest.head.y * 100)}%;`
        );
    });

    it("is the manifest's still, a JPG of Brokk", () => {
        expect(Manifest.still).toBe("brokk.jpg");
        expect(existsSync(join(Folder, Manifest.still))).toBe(true);
        expect(statSync(join(Folder, Manifest.still)).size).toBeLessThan(600_000);
    });
});

describe("what Brokk's face never reads (FR-BOSS-007, AC2)", () => {
    const files = [
        "brokk-portrait.ts",
        "brokk-state-model.ts",
        "brokk-expression-model.ts",
        "brokk-expressions.ts",
        "brokk-live.tsx",
        "use-brokk-live.ts",
    ];

    it("looks for no [[expression]] marker in an agent's output, a file or code", () => {
        for (const file of files) {
            const source = readFileSync(join(__dirname, file), "utf8").replace(/\/\/.*$/gm, "");
            expect(source, file).not.toMatch(
                /stripExpressionMarkers|readExpression|@diamondforge\/character\/contract/
            );
            expect(source, file).not.toContain("[[");
        }
    });

    it("imports the package's portrait and nothing of its contract", () => {
        const live = readFileSync(join(__dirname, "brokk-live.tsx"), "utf8");
        expect(live).toContain('from "@diamondforge/character"');
        expect(live).toContain('import "@diamondforge/character/styles.css"');
    });
});

describe("the declaration the build gives", () => {
    it("is typed as the package's props", () => {
        const declaration: BrokkDeclaration = BrokkPortrait;
        expect(declaration.src).toMatch(/brokk[^/]*\.jpg/);
    });
});
