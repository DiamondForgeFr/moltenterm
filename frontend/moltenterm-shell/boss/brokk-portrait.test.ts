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
    declarationForPoses,
    IdleGaps,
    makeBrokkDeclaration,
    RestState,
    rhythmProps,
} from "./brokk-portrait";
import Manifest from "./portrait/brokk/brokk-manifest.json";

const Folder = join(__dirname, "portrait", "brokk");
const Root = join(__dirname, "..", "..", "..");
const PackageName = "@diamondforge/character";

function textOf(file: string): string {
    return readFileSync(join(Root, file), "utf8");
}

// A stylesheet without its comments, which explain the rules in words the patterns below would catch.
function css(file: string): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Brokk's declaration (FR-BOSS-007, AC1)", () => {
    const declaration = makeBrokkDeclaration(Manifest as BrokkManifest, "/clips", "/brokk.jpg");

    it("is a plain object for the package's portrait: the still, the folder of the clips, the name of the resting pose, the transitions and the gestures", () => {
        expect(Object.keys(declaration).sort()).toEqual(["idles", "loops", "restState", "src", "transitions"]);
        expect(declaration.src).toBe("/brokk.jpg");
        expect(declaration.loops).toBe("/clips");
    });

    it("declares the transitions of the manifest, and none between two poses that look alike", () => {
        expect(declaration.transitions).toEqual([
            "listening>thinking",
            "speaking>thinking",
            "thinking>listening",
            "thinking>speaking",
            "listening>rest",
            "speaking>rest",
            "rest>listening",
            "rest>speaking",
            "thinking>rest",
            "rest>thinking",
        ]);
        expect(declaration.transitions).not.toContain("listening>speaking");
        expect(declaration.transitions).not.toContain("speaking>listening");
    });

    it("declares the gestures with their weights: the blink, the only one drawn by chance, weighs and may repeat; every other waits to be asked", () => {
        expect(declaration.idles).toEqual({
            listening: [
                { name: "blink", weight: 4, repeat: true },
                { name: "nod", onDemand: true },
                { name: "doubtful", onDemand: true },
                { name: "frown", onDemand: true },
                { name: "smile", onDemand: true },
                { name: "call", onDemand: true },
            ],
            speaking: [
                { name: "blink", weight: 2, repeat: true },
                { name: "nod", onDemand: true },
            ],
        });
    });

    it("names the resting pose `rest`, as the manifest does, and not `offline`, which is the package's default", () => {
        expect(RestState).toBe("rest");
        expect(declaration.restState).toBe("rest");
        expect(Manifest.states).toContain("rest");
        expect(JSON.stringify(declaration)).not.toContain("offline");
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

    it("hold the resting pose's under its own name, the manifest's, and none under the package's default", () => {
        expect(existsSync(join(Folder, "rest.webm"))).toBe(true);
        for (const state of ["listening", "thinking", "speaking"]) {
            expect(existsSync(join(Folder, `rest-to-${state}.webm`))).toBe(true);
            expect(existsSync(join(Folder, `${state}-to-rest.webm`))).toBe(true);
        }
        expect(found.filter((name) => name.includes("offline"))).toEqual([]);
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
        "brokk-ask-model.ts",
        "brokk-state-model.ts",
        "brokk-scene.ts",
        "brokk-mood.ts",
        "brokk-queue.ts",
        "brokk-watch.ts",
        "brokk-moments.ts",
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

describe("the rhythm of his gestures (FR-BOSS-007, AC17)", () => {
    const declaration = makeBrokkDeclaration(Manifest as BrokkManifest, "/clips", "/brokk.jpg");

    it("gives the package the gap the scene's rhythm asks for: 6 to 14 s normally, 12 to 30 s when calm", () => {
        expect(rhythmProps("normal")).toEqual({ idleGap: { minMs: 6000, maxMs: 14000 } });
        expect(rhythmProps("calm")).toEqual({ idleGap: { minMs: 12000, maxMs: 30000 } });
    });

    it("makes calm calmer: both ends of its gap are longer, and its mean is at least half as long again", () => {
        const normal = IdleGaps.normal;
        const calm = IdleGaps.calm;
        expect(calm.minMs).toBeGreaterThan(normal.minMs);
        expect(calm.maxMs).toBeGreaterThan(normal.maxMs);
        expect(calm.minMs + calm.maxMs).toBeGreaterThanOrEqual(1.5 * (normal.minMs + normal.maxMs));
    });

    it("gives gaps the package can draw from: the shortest starts before the longest ends, and none is zero", () => {
        for (const gap of Object.values(IdleGaps)) {
            expect(gap.minMs).toBeGreaterThan(0);
            expect(gap.maxMs).toBeGreaterThan(gap.minMs);
        }
    });

    it("hands the same gap for the same rhythm, so that only a change of rhythm changes the prop", () => {
        expect(rhythmProps("normal")).toBe(rhythmProps("normal"));
        expect(rhythmProps("calm")).toBe(rhythmProps("calm"));
        expect(rhythmProps("calm")).not.toBe(rhythmProps("normal"));
    });

    it("keeps the rhythm out of the declaration, which is the same for both: the gap is a prop of the moment", () => {
        expect(Object.keys(declaration)).not.toContain("idleGap");
    });

    it("leaves the chance to the blink in every pose: it is the one gesture drawn by chance, and it may repeat", () => {
        const poses = Object.entries(declaration.idles);
        expect(poses.map(([pose]) => pose).sort()).toEqual(["listening", "speaking"]);
        for (const [pose, idles] of poses) {
            const byChance = idles.filter((idle) => !idle.onDemand);
            expect(
                byChance.map((idle) => idle.name),
                pose
            ).toEqual(["blink"]);
            expect(byChance[0].repeat, pose).toBe(true);
        }
    });

    it("keeps the nod for when it is asked: on demand wherever he can nod, so that none comes by chance", () => {
        const poses = Object.entries(declaration.idles).filter(([, idles]) =>
            idles.some((idle) => idle.name === "nod")
        );
        expect(poses.map(([pose]) => pose).sort()).toEqual(["listening", "speaking"]);
        for (const [pose, idles] of poses) {
            expect(idles.find((idle) => idle.name === "nod").onDemand, pose).toBe(true);
        }
    });

    it("repeats only what the manifest says may repeat", () => {
        const odd: BrokkManifest = {
            ...(Manifest as BrokkManifest),
            idles: {
                listening: [
                    { name: "blink", weight: 1, repeat: true },
                    { name: "smile", onDemand: true },
                ],
            },
        };
        expect(makeBrokkDeclaration(odd, "/c", "/s.jpg").idles.listening).toEqual([
            { name: "blink", weight: 1, repeat: true },
            { name: "smile", onDemand: true },
        ]);
    });
});

describe("the package at v0.3.1 (FR-BOSS-007, AC1 and AC17; #1999, #2007)", () => {
    const lock = JSON.parse(textOf("package-lock.json"));
    const manifest = JSON.parse(textOf("package.json"));

    it("is named at v0.3.1 by the dependency, the lock, the notice and the ledger of the fork", () => {
        expect(manifest.dependencies[PackageName]).toMatch(/character-studio\.git#v0\.3\.1$/);
        expect(lock.packages[""].dependencies[PackageName]).toMatch(/character-studio\.git#v0\.3\.1$/);
        expect(lock.packages[`node_modules/${PackageName}`].version).toBe("0.3.1");
        expect(textOf("NOTICE")).toContain(`${PackageName} 0.3.1 by DiamondForge`);
        expect(textOf("UPSTREAM.md")).toContain("character-studio.git#v0.3.1");
        expect(textOf("UPSTREAM.md")).not.toContain("diamondforge-character.git#v0.2.0");
    });

    it("is the one installed, with the gap, the repeat and the end of a gesture in its types", () => {
        const installed = JSON.parse(textOf(`node_modules/${PackageName}/package.json`));
        expect(installed.version).toBe("0.3.1");
        const types = textOf(`node_modules/${PackageName}/dist/transmission-portrait.d.ts`);
        expect(types).toContain("idleGap?: TransmissionIdleGap");
        expect(types).toContain("onGesture?: (name: string, phase: TransmissionGesturePhase) => void");
        expect(types).toContain("repeat?: boolean");
    });

    it("keeps the next loop under the clip that leads to it, with the stylesheet the app takes from the package", () => {
        const styles = textOf(`node_modules/${PackageName}/dist/styles.css`);
        expect(styles).toMatch(/\.character-video-under \{\s*opacity: 1;\s*transition: opacity 0s linear 0\.3s;/);
        const live = readFileSync(join(__dirname, "brokk-live.tsx"), "utf8");
        expect(live).toContain(`import "${PackageName}/styles.css"`);
    });

    it("overrides nothing of what the loop under the clip needs: no opacity, no class of the fade, no transition but off", () => {
        const live = css("brokk-live.css");
        expect(live).not.toMatch(/opacity/);
        expect(live).not.toMatch(/character-video-(on|off|under)/);
        const rules = [...live.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
            selector.includes(".character-video")
        );
        expect(rules.length).toBeGreaterThan(0);
        const allowed = ["user-select: none", "-webkit-user-select: none", "pointer-events: none", "transition: none"];
        for (const [, selector, body] of rules) {
            for (const declaration of body
                .split(";")
                .map((line) => line.trim())
                .filter(Boolean)) {
                expect(allowed, `${selector.trim()} { ${declaration} }`).toContain(declaration);
            }
        }
    });
});

describe("the declaration of a face that takes some poses only (#2154)", () => {
    const declaration = makeBrokkDeclaration(Manifest as BrokkManifest, "/clips", "/brokk.jpg");

    it("keeps the transitions between those poses and none that leave them", () => {
        const narrowed = declarationForPoses(declaration, ["listening", "thinking"]);
        expect(narrowed.transitions).toEqual(["listening>thinking", "thinking>listening"]);
        expect(declaration.transitions).toContain("listening>rest");
        expect(declaration.transitions).toContain("thinking>speaking");
    });

    it("changes nothing else of the declaration: the loops, the gestures and the picture are the same", () => {
        const narrowed = declarationForPoses(declaration, ["listening", "thinking"]);
        expect({ ...narrowed, transitions: undefined }).toEqual({ ...declaration, transitions: undefined });
        expect(narrowed.idles).toBe(declaration.idles);
    });

    it("keeps every transition for all four poses", () => {
        const all = declarationForPoses(declaration, ["listening", "thinking", "speaking", "rest"]);
        expect(all.transitions).toEqual(declaration.transitions);
    });
});
