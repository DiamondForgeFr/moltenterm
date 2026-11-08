// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Package = vi.hoisted(() => ({ props: null as Record<string, any> }));
const Face = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@diamondforge/character", () => ({
    TransmissionPortrait: (props: Record<string, any>) => {
        Package.props = props;
        return null;
    },
}));
vi.mock("./brokk-moments", () => ({ startMoments: () => () => {} }));
// A server render never runs an effect or a dispatch of its own: the face's reducer is stood in for, so that what the
// component sends it can be read.
vi.mock("react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react")>();
    return {
        ...actual,
        useReducer: (_reducer: unknown, arg: unknown, init: (arg: unknown) => unknown) => [init(arg), Face.dispatch],
    };
});

import { BrokkLive, type BrokkLiveProps } from "./brokk-live";
import { BrokkPortrait, IdleGaps, rhythmProps } from "./brokk-portrait";

const Live: BrokkLiveProps = {
    situation: { working: 0, waiting: 0, cardOpen: false },
    asked: null,
};

function draw(live: BrokkLiveProps = Live): string {
    return renderToStaticMarkup(<BrokkLive {...live} />);
}

describe("the animated portrait hands the package the rhythm (FR-BOSS-007, AC17)", () => {
    beforeEach(() => {
        Package.props = null;
    });

    it("asks for the normal gap when the scene gives none", () => {
        draw();
        expect(Package.props.idleGap).toBe(IdleGaps.normal);
    });

    it.each(["normal", "calm"] as const)("asks for the gap of the %s rhythm", (rhythm) => {
        draw({ ...Live, rhythm });
        expect(Package.props.idleGap).toBe(rhythmProps(rhythm).idleGap);
        expect(Package.props.idleGap).toBe(IdleGaps[rhythm]);
    });

    it("changes the gap with the rhythm, on the same portrait, with no other prop of the pose changed", () => {
        draw({ ...Live, rhythm: "normal" });
        const normal = Package.props;
        draw({ ...Live, rhythm: "calm" });
        const calm = Package.props;
        expect(calm.idleGap).not.toBe(normal.idleGap);
        expect(calm.idleGap.minMs).toBeGreaterThan(normal.idleGap.minMs);
        expect(calm.state).toBe(normal.state);
        expect(calm.loops).toBe(normal.loops);
        expect(calm.idles).toBe(normal.idles);
    });

    it("still declares Brokk to the package: his clips, his poses and the picture alone", () => {
        draw();
        expect(Package.props.loops).toBe(BrokkPortrait.loops);
        expect(Package.props.restState).toBe("rest");
        expect(Package.props.idles).toBe(BrokkPortrait.idles);
        expect(Package.props.bare).toBe(true);
        expect(Package.props.state).toBe("listening");
    });
});

describe("the animated portrait hears the end of a gesture from the package (FR-BOSS-007, AC17)", () => {
    beforeEach(() => {
        Package.props = null;
        Face.dispatch.mockClear();
    });

    it("gives the package an `onGesture`, and no listener on the video elements it draws", () => {
        const html = draw();
        expect(typeof Package.props.onGesture).toBe("function");
        expect(html).toContain('data-testid="brokk-live"');
        const source = readFileSync(join(__dirname, "brokk-live.tsx"), "utf8").replace(/\/\/.*$/gm, "");
        expect(source).not.toContain("data-video");
        expect(source).not.toContain("onEndedCapture");
        expect(source).not.toContain("getAttribute");
    });

    it("hands the pose back when the package says a gesture ended, by the gesture's name", () => {
        draw();
        Package.props.onGesture("call", "end");
        expect(Face.dispatch).toHaveBeenCalledTimes(1);
        expect(Face.dispatch).toHaveBeenCalledWith({ type: "gesture-ended", name: "call" });
    });

    it("hands the pose back whichever gesture ended, a blink drawn by chance included: the face tells them apart", () => {
        draw();
        Package.props.onGesture("blink", "end");
        expect(Face.dispatch).toHaveBeenCalledWith({ type: "gesture-ended", name: "blink" });
    });

    it("does nothing when a gesture starts", () => {
        draw();
        Package.props.onGesture("call", "start");
        expect(Face.dispatch).not.toHaveBeenCalled();
    });

    it("plays the gesture asked, as an expression of the package", () => {
        const call = { expression: "call" as const, cue: 3 };
        draw({ ...Live, asked: call, play: call });
        expect(Package.props.expression).toBe(call);
    });
});
