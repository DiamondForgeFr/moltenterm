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
import { SeverityExpression } from "./brokk-queue";
import { BrokkTones, ToneGesture } from "./brokk-tone";
import { SceneWaitGestures } from "./brokk-visit-scene-model";
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

    it("declares the gestures with their weights: the waiting idles drawn by chance, the blink alone repeating; every other waits to be asked (#2262)", () => {
        expect(declaration.idles).toEqual({
            listening: [
                { name: "blink", weight: 4, repeat: true },
                { name: "nod", onDemand: true },
                { name: "glance", weight: 2 },
                { name: "breath", weight: 2 },
                { name: "lookaround" },
                { name: "beard" },
                { name: "scratch" },
                { name: "doubtful", onDemand: true },
                { name: "frown", onDemand: true },
                { name: "smile", onDemand: true },
                { name: "call", onDemand: true },
                { name: "sigh", onDemand: true },
                { name: "proud", onDemand: true },
                { name: "chuckle", onDemand: true },
                { name: "surprised", onDemand: true },
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
        expect(found).toHaveLength(31);
    });

    it("are each under 1 MB, and within the portrait's 15 MB with the still (480 x 480, 16 fps, validated by DiamondForge)", () => {
        const sizes = found.map((name) => statSync(join(Folder, `${name}.webm`)).size);
        for (const size of sizes) {
            expect(size).toBeLessThan(1_000_000);
        }
        const still = statSync(join(Folder, Manifest.still)).size;
        expect(sizes.reduce((sum, size) => sum + size, still)).toBeLessThan(15_000_000);
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

    it("draws by chance the waiting idles at the weights the ticket gives in the listening pose, and the blink alone in the speaking pose (#2262)", () => {
        const drawn = (pose: "listening" | "speaking") =>
            declaration.idles[pose].filter((idle) => !idle.onDemand).map((idle) => [idle.name, idle.weight ?? 1]);
        expect(Object.keys(declaration.idles).sort()).toEqual(["listening", "speaking"]);
        expect(drawn("listening")).toEqual([
            ["blink", 4],
            ["glance", 2],
            ["breath", 2],
            ["lookaround", 1],
            ["beard", 1],
            ["scratch", 1],
        ]);
        expect(drawn("speaking")).toEqual([["blink", 2]]);
    });

    it("lets the blink alone repeat, so that no other gesture drawn by chance comes twice in a row (#2262)", () => {
        for (const [pose, idles] of Object.entries(declaration.idles)) {
            expect(
                idles.filter((idle) => idle.repeat).map((idle) => idle.name),
                pose
            ).toEqual(["blink"]);
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

describe("every gesture of his manifest has its use (#2262)", () => {
    // What MoltenTerm asks of him: the tone of his answer, the face of a visit and what a grave visit does while it
    // waits, and the gestures asked by name (the call of the badge, the nods, the smile of a merge, the moods).
    const AskedBy = ["brokk-expressions.ts", "brokk-watch.ts", "use-brokk-hello.ts"];
    // A gesture of his set that MoltenTerm leaves out on purpose, with the reason. None today.
    const LeftOut: Record<string, string> = {};

    function asked(): Map<string, string[]> {
        const rtn = new Map<string, string[]>();
        const add = (name: string, by: string) => rtn.set(name, [...(rtn.get(name) ?? []), by]);
        for (const tone of BrokkTones) {
            if (ToneGesture[tone] != null) {
                add(ToneGesture[tone], `the ${tone} tone`);
            }
        }
        for (const [severity, expression] of Object.entries(SeverityExpression)) {
            add(expression, `a ${severity} visit`);
        }
        for (const [severity, expression] of Object.entries(SceneWaitGestures)) {
            add(expression, `a ${severity} visit while he waits`);
        }
        for (const file of AskedBy) {
            const source = readFileSync(join(__dirname, file), "utf8");
            for (const [, name] of source.matchAll(/\bask\("([a-z]+)"/g)) {
                add(name, file);
            }
        }
        return rtn;
    }

    const listening = Manifest.idles.listening as { name: string; onDemand?: boolean }[];
    const speaking = Manifest.idles.speaking as { name: string; onDemand?: boolean }[];

    it("asks only gestures his listening pose has, kept for when they are asked and timed by the manifest", () => {
        for (const [name, by] of asked()) {
            expect(
                listening.find((idle) => idle.name === name),
                `${name} (${by.join(", ")})`
            ).toMatchObject({ onDemand: true });
            expect(Manifest.expressionMs, name).toHaveProperty(name);
        }
    });

    it("uses each gesture of the manifest: drawn by chance, asked by MoltenTerm, or left out on purpose", () => {
        const used = asked();
        for (const idle of [...listening, ...speaking]) {
            const drawn = !idle.onDemand;
            expect(drawn || used.has(idle.name) || idle.name in LeftOut, idle.name).toBe(true);
        }
        for (const name of Object.keys(LeftOut)) {
            expect(listening.some((idle) => idle.name === name) && !used.has(name), name).toBe(true);
        }
    });

    it("plays the sigh only on a grave visit, never by chance", () => {
        expect(asked().get("sigh")).toEqual(["a grave visit while he waits"]);
        expect(listening.find((idle) => idle.name === "sigh")).toMatchObject({ onDemand: true });
    });

    it("times every gesture it asks, and nothing it never asks", () => {
        expect(Object.keys(Manifest.expressionMs).sort()).toEqual([...asked().keys()].sort());
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
