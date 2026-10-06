// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MapSvg, MotionStyles, ReplayButton } from "./line-map";
import { layoutLineMap } from "./line-map-geometry";
import { LineMapBranch, LineMapModel, LineMapStation } from "./line-map-model";

const Day = 86_400_000;
const NOW = new Date("2026-10-05T12:00:00Z").getTime();

function station(name: string, at: number): LineMapStation {
    return {
        name,
        sha: name,
        at,
        date: new Date(at).toISOString(),
        kind: "rc",
        notes: null,
        source: { sha: "s" + name, at: at - Day / 4, date: "", subject: "" },
        latest: false,
        url: null,
    };
}

function branch(id: string, fork: number, merge: number, over: Partial<LineMapBranch> = {}): LineMapBranch {
    return {
        id,
        name: id,
        ticket: null,
        state: "merged",
        fork,
        forkKnown: true,
        merge,
        mergeSha: null,
        commits: [],
        count: 2,
        countCapped: false,
        pr: null,
        prNumber: null,
        ci: null,
        url: null,
        ...over,
    };
}

function model(): LineMapModel {
    return {
        start: NOW - 21 * Day,
        now: NOW,
        days: 21,
        trunk: "develop",
        release: "main",
        head: { sha: "abc1234", at: NOW - Day, date: "", subject: "feat(#1): x" },
        commits: [],
        branches: [
            branch("feature/1-a", NOW - 15 * Day, NOW - 12 * Day),
            branch("fix/2-b", NOW - 9 * Day, NOW - 8 * Day, { forkKnown: false }),
            branch("fix/3-open", NOW - 2 * Day, null, { state: "open", merge: null }),
        ],
        stations: [station("v1.0.0-1", NOW - 10 * Day), station("v1.0.0-2", NOW - 4 * Day)],
        earlier: [],
        terminus: { version: "1.0.0", tag: "v1.0.0", how: "decision", reason: "", waiting: 3 },
        github: "",
        historyFrom: null,
    } as LineMapModel;
}

function render(ciRunning: string): string {
    const m = model();
    const geo = layoutLineMap(m, { width: 1400 });
    return renderToStaticMarkup(<MapSvg geo={geo} model={m} ciRunning={ciRunning} hit={() => ({})} />);
}

describe("line map motion hooks in the drawing", () => {
    it("marks CI running on develop, idle otherwise", () => {
        expect(render("develop")).toContain('data-ci="running"');
        expect(render("feature/9-x")).toContain('data-ci="idle"');
        expect(render(null)).toContain('data-ci="idle"');
    });

    it("lays a glint strip exactly over develop and over main, and no moving vehicle", () => {
        const geo = layoutLineMap(model(), { width: 1400 });
        const html = render(null);
        const strip = (line: { x1: number; x2: number; y: number }, h: number) =>
            `style="left:${line.x1}px;top:${line.y - h / 2}px;width:${line.x2 - line.x1}px;height:${h}px"`;
        expect(html).toContain(`class="lm-glints lm-glints-dev" ${strip(geo.develop, 6)}`);
        expect(html).toContain(`class="lm-glints lm-glints-main" ${strip(geo.main, 4)}`);
        expect(html.match(/class="lm-glint-band"/g)).toHaveLength(2);
        expect(html).not.toMatch(/train|vehicle/i);
    });

    it("rings the head with the pulse", () => {
        const geo = layoutLineMap(model(), { width: 1400 });
        const rings = [
            ...render(null).matchAll(
                /class="lm-ring" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" stroke-opacity="([\d.]+)"/g
            ),
        ];
        expect(rings).toHaveLength(3);
        for (const r of rings) {
            expect([Number(r[1]), Number(r[2])]).toEqual([geo.head.x, geo.head.y]);
        }
        expect(rings.map((r) => Number(r[3]))).toEqual([12, 15.5, 19]);
        expect(rings.map((r) => Number(r[4]))).toEqual([0.7, 0.45, 0.25]);
    });

    it("keeps three copies of the route for its march, a third of a dash apart", () => {
        const html = render(null);
        expect(html.match(/class="lm-route lm-route-base"/g)).toHaveLength(1);
        expect(html.match(/class="lm-route lm-route-echo lm-route-echo-\d"/g)).toHaveLength(3);
    });

    it("holds the static CI badge only while CI runs on develop", () => {
        expect(render("develop")).toContain('data-testid="line-map-ci-badge"');
        expect(render(null)).not.toContain("line-map-ci-badge");
    });

    it("gives the solid lines a unit length to draw, never the dashed ones", () => {
        const html = render(null);
        expect(html).toMatch(/class="lm-main"[^>]*pathLength="1"/);
        expect(html).toMatch(/class="lm-dev"[^>]*pathLength="1"/);
        expect(html).toMatch(/class="lm-br-open"[^>]*pathLength="1"/);
        expect(html).not.toMatch(/class="lm-route[^"]*"[^>]*pathLength/);
        expect(html).not.toMatch(/class="lm-br lm-br-guess"[^>]*pathLength/);
    });

    it("staggers the stations left to right", () => {
        const html = render(null);
        const delays = [...html.matchAll(/class="lm-st"[^>]*style="--lm-d:([\d.]+)s"/g)].map((m) => Number(m[1]));
        expect(delays).toHaveLength(2);
        expect(delays[0]).toBeLessThan(delays[1]);
    });

    it("keeps the clock that ends the load sequence", () => {
        expect(render(null)).toContain('class="lm-clock"');
    });
});

describe("Replay", () => {
    it("shows with motion on and is hidden under reduced motion", () => {
        expect(renderToStaticMarkup(<ReplayButton reduced={false} onReplay={() => {}} />)).toContain("Replay");
        expect(renderToStaticMarkup(<ReplayButton reduced={true} onReplay={() => {}} />)).toBe("");
    });
});

describe("motion CSS", () => {
    it("plays the load sequence only with motion on and while it plays", () => {
        expect(MotionStyles).toContain('.lm-frame[data-motion="full"][data-intro="play"] .lm-main');
        expect(MotionStyles).toMatch(/\[data-intro="play"\] \.lm-st[^{]*\{[^}]*lm-pop/);
    });

    it("runs the continuous motion only with motion on", () => {
        for (const cls of ["lm-glint-band", "lm-route-echo", "lm-ring", "lm-tip"]) {
            expect(MotionStyles).toContain(`.lm-frame[data-motion="full"] .${cls} {`);
        }
    });

    it("moves the glints left to right, 5 px a step, faster and brighter on develop while CI runs there", () => {
        expect(MotionStyles).toContain(
            '.lm-frame[data-motion="full"] .lm-glint-band { animation: lm-glide 8s steps(32) infinite; }'
        );
        expect(MotionStyles).toContain(
            "@keyframes lm-glide { from { transform: translateX(0); } to { transform: translateX(160px); } }"
        );
        expect(MotionStyles).toContain('.lm-plot[data-ci="running"] .lm-glints-dev { opacity: .9; }');
        expect(MotionStyles).toContain(
            '.lm-plot[data-ci="running"] .lm-glints-dev .lm-glint-band { animation-duration: 2s; }'
        );
    });

    it("marches the route forward: each copy a third further, a third of the cycle later", () => {
        expect(MotionStyles).toContain(".lm-route-echo-1 { stroke-dashoffset: -4.67; animation-delay: -0.500s; }");
        expect(MotionStyles).toContain(".lm-route-echo-2 { stroke-dashoffset: -9.33; animation-delay: -0.250s; }");
    });

    it("pauses every animation when hidden", () => {
        expect(MotionStyles).toContain('.lm-frame[data-paused="true"] .lm-plot * { animation-play-state: paused');
    });

    it("hides the glints and the pulse under reduced motion and shows the CI badge instead", () => {
        expect(MotionStyles).toContain('.lm-frame[data-motion="reduce"] .lm-flows');
        expect(MotionStyles).toContain('.lm-frame[data-motion="reduce"] .lm-pulse { display: none; }');
        expect(MotionStyles).toContain('.lm-frame[data-motion="reduce"] .lm-cibadge { display: inline; }');
    });

    function keyframeProps(names: string[]): string[] {
        const blocks = [...MotionStyles.matchAll(/@keyframes ([\w-]+) \{([^@]*)\}/g)].filter((m) =>
            names.includes(m[1])
        );
        expect(blocks).toHaveLength(names.length);
        return [...new Set(blocks.flatMap((m) => [...m[2].matchAll(/([a-z-]+):/g)].map((p) => p[1])))].sort();
    }

    it("draws the load sequence with dashoffset, opacity and transform only", () => {
        expect(keyframeProps(["lm-draw", "lm-fade", "lm-pop", "lm-clock"])).toEqual([
            "opacity",
            "stroke-dashoffset",
            "transform",
        ]);
    });

    it("steps every continuous animation, so a frame is drawn only when a step changes", () => {
        const continuous = [...MotionStyles.matchAll(/animation: lm-(glide|chase|ripple|blink) [^;]*;/g)].map(
            (m) => m[0]
        );
        expect(continuous).toHaveLength(4);
        for (const rule of continuous) {
            expect(rule).toMatch(/step-end|steps\(/);
        }
    });

    it("moves continuously with opacity, and with a transform only on HTML, both run by the compositor", () => {
        expect(keyframeProps(["lm-chase", "lm-ripple", "lm-blink"])).toEqual(["opacity"]);
        expect(keyframeProps(["lm-glide"])).toEqual(["transform"]);
    });

    it("hands a chase's light from one copy to the next: lit at the start and the end of its share only", () => {
        expect(MotionStyles).toContain(
            "@keyframes lm-ripple { 0% { opacity: 1; } 10.000% { opacity: 0; } 100% { opacity: 0; } }"
        );
        expect(MotionStyles).toContain(
            "@keyframes lm-chase { 0% { opacity: 1; } 33.333% { opacity: 0; } 100% { opacity: 0; } }"
        );
    });
});
