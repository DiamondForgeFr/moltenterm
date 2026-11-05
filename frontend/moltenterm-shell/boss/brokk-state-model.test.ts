// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    askedAfter,
    BrokkExpression,
    BrokkExpressions,
    brokkPose,
    BrokkSituation,
    callPending,
    CallYieldMs,
    faceAfter,
    gestureOfClip,
    handledAfter,
    reactionCapMs,
    restingPose,
    speaksOnOpen,
    startFace,
} from "./brokk-state-model";
import Manifest from "./portrait/brokk/brokk-manifest.json";

function situation(partial: Partial<BrokkSituation> = {}): BrokkSituation {
    return { working: 0, waiting: 0, cardOpen: false, ...partial };
}

const NoFace = { speaking: false, expression: null as BrokkExpression };

describe("his pose from MoltenTerm's signals (FR-BOSS-007, AC2)", () => {
    it.each([
        ["nothing works, nothing waits, the card is closed", situation(), "rest"],
        ["an agent works and nothing waits", situation({ working: 1 }), "thinking"],
        ["several agents work and nothing waits", situation({ working: 5 }), "thinking"],
        ["something waits for the developer", situation({ waiting: 1 }), "listening"],
        ["something waits while agents work", situation({ working: 3, waiting: 2 }), "listening"],
        ["the card is open with nothing going on", situation({ cardOpen: true }), "listening"],
        ["the card is open while an agent works", situation({ cardOpen: true, working: 1 }), "thinking"],
        ["the card is open on items to handle", situation({ cardOpen: true, waiting: 4 }), "listening"],
    ])("%s: %s", (_label, s, pose) => {
        expect(restingPose(s)).toBe(pose);
        expect(brokkPose(s, NoFace)).toBe(pose);
    });

    it("speaks for a few seconds, and only where something waits to be handled", () => {
        const speaking = { speaking: true, expression: null as BrokkExpression };
        expect(brokkPose(situation({ cardOpen: true, waiting: 2 }), speaking)).toBe("speaking");
        expect(brokkPose(situation({ cardOpen: true }), speaking)).toBe("listening");
        expect(brokkPose(situation({ working: 1 }), speaking)).toBe("thinking");
        expect(brokkPose(situation(), speaking)).toBe("rest");
    });

    it("speaks on opening the card when it opens on items to handle, not on an empty card", () => {
        expect(speaksOnOpen(situation({ cardOpen: true, waiting: 1 }))).toBe(true);
        expect(speaksOnOpen(situation({ cardOpen: true, working: 2 }))).toBe(false);
        expect(speaksOnOpen(situation({ cardOpen: true }))).toBe(false);
    });

    it("never reads an expression from what an agent writes: the situation holds three numbers and a flag", () => {
        expect(Object.keys(situation()).sort()).toEqual(["cardOpen", "waiting", "working"]);
    });
});

describe("the pose while he makes a gesture (AC3)", () => {
    it("takes the listening pose, whatever he was doing, since the gestures are clips of that loop", () => {
        for (const expression of ["smile", "doubtful", "frown", "call"] as BrokkExpression[]) {
            expect(brokkPose(situation(), { speaking: false, expression })).toBe("listening");
            expect(brokkPose(situation({ working: 1 }), { speaking: false, expression })).toBe("listening");
            expect(brokkPose(situation({ waiting: 1 }), { speaking: false, expression })).toBe("listening");
        }
    });

    it("stays speaking for the gestures the speaking loop has (the nod), and listens for the others", () => {
        const s = situation({ cardOpen: true, waiting: 2 });
        expect(brokkPose(s, { speaking: true, expression: "nod" })).toBe("speaking");
        expect(brokkPose(s, { speaking: true, expression: "smile" })).toBe("listening");
    });

    it("keeps the gestures the app asks within the ones the manifest gives a listening clip to", () => {
        const listening = Manifest.idles.listening.map((idle) => idle.name);
        for (const expression of BrokkExpressions) {
            expect(listening).toContain(expression);
        }
    });

    it("lists the expressions the manifest times", () => {
        expect([...BrokkExpressions].sort()).toEqual(["call", "doubtful", "frown", "nod", "smile"]);
    });

    it("gives a gesture longer than its clip to end, so a clip that never ends does not hold the pose forever", () => {
        for (const expression of BrokkExpressions) {
            const clip = (Manifest.expressionMs as Record<string, number>)[expression];
            expect(reactionCapMs(expression)).toBeGreaterThan(clip);
        }
    });
});

describe("the call the round makes when the count rises (AC3)", () => {
    const call = { expression: "call" as BrokkExpression, cue: 3 };

    it("plays the call just asked, once the round can show it", () => {
        expect(callPending(call, 2, false)).toBe(true);
        expect(callPending(call, 3, false)).toBe(false);
        expect(callPending(null, 0, false)).toBe(false);
    });

    it("plays no other gesture at rest: the round makes the call and nothing else", () => {
        for (const expression of ["smile", "doubtful", "frown", "nod"] as BrokkExpression[]) {
            expect(callPending({ expression, cue: 9 }, 0, false)).toBe(false);
        }
    });

    it("does not play a call it could not show, later: it is spent when it is asked", () => {
        expect(callPending(call, 2, true)).toBe(false);
        expect(handledAfter(2, call, true)).toBe(3);
        expect(callPending(call, handledAfter(2, call, true), false)).toBe(false);
    });

    it("keeps the newest cue it has handled, and plays the next call asked", () => {
        expect(handledAfter(5, call, true)).toBe(5);
        expect(handledAfter(2, call, false)).toBe(2);
        expect(handledAfter(2, null, true)).toBe(2);
        expect(callPending({ expression: "call", cue: 6 }, 5, false)).toBe(true);
    });
});

describe("the gesture asked (AC3)", () => {
    it("is the first one asked, with a cue of its own each time, the same gesture twice included", () => {
        const first = askedAfter(null, "smile", 1000);
        expect(first).toEqual({ expression: "smile", cue: 1, at: 1000 });
        expect(askedAfter(first, "smile", 2000)).toEqual({ expression: "smile", cue: 2, at: 2000 });
        expect(askedAfter(first, "nod", 2000)).toEqual({ expression: "nod", cue: 2, at: 2000 });
    });

    it("lets a gesture that tells why win over the call asked in the same moment, whichever comes first", () => {
        const frown = askedAfter(null, "frown", 1000);
        expect(askedAfter(frown, "call", 1000 + CallYieldMs - 1)).toBe(frown);
        const call = askedAfter(null, "call", 1000);
        expect(askedAfter(call, "frown", 1001)).toEqual({ expression: "frown", cue: 2, at: 1001 });
    });

    it("plays the call again once the moment has passed, and a call after a call", () => {
        const frown = askedAfter(null, "frown", 1000);
        expect(askedAfter(frown, "call", 1000 + CallYieldMs)).toEqual({
            expression: "call",
            cue: 2,
            at: 1000 + CallYieldMs,
        });
        const call = askedAfter(null, "call", 1000);
        expect(askedAfter(call, "call", 1001)).toEqual({ expression: "call", cue: 2, at: 1001 });
    });
});

describe("the gesture a clip plays", () => {
    it("reads it from the clip's name, and finds none in a loop or a transition", () => {
        expect(gestureOfClip("/assets/portrait/brokk/listening.smile")).toBe("smile");
        expect(gestureOfClip("file:///app/assets/portrait/brokk/speaking.nod")).toBe("nod");
        expect(gestureOfClip("/assets/portrait/brokk/listening")).toBe("");
        expect(gestureOfClip("/assets/portrait/brokk/listening-to-thinking")).toBe("");
        expect(gestureOfClip("")).toBe("");
        expect(gestureOfClip(undefined)).toBe("");
    });
});

describe("the face's clocks", () => {
    const call = { expression: "call" as BrokkExpression, cue: 7 };
    const smile = { expression: "smile" as BrokkExpression, cue: 8 };

    it("starts at rest of gestures, and plays the one that put it on screen", () => {
        expect(startFace({}).reaction).toBeNull();
        expect(startFace({ play: call }).reaction).toBe(call);
        expect(startFace({ speaks: true }).speaking).toBe(true);
    });

    it("does not play again a gesture asked before it mounted", () => {
        const state = startFace({ asked: smile });
        expect(faceAfter(state, { type: "asked", asked: smile })).toBe(state);
        const later = faceAfter(state, { type: "asked", asked: { ...smile, cue: 9 } });
        expect(later.reaction.cue).toBe(9);
    });

    it("plays the call it mounted for once, and a gesture asked after it replaces it", () => {
        const state = startFace({ asked: call, play: call });
        expect(faceAfter(state, { type: "asked", asked: call })).toBe(state);
        expect(faceAfter(state, { type: "asked", asked: smile }).reaction).toBe(smile);
    });

    it("hands the pose back when the clip of the gesture ends, and not for another clip", () => {
        const state = startFace({ play: call });
        expect(faceAfter(state, { type: "clip-ended", base: "/a/portrait/brokk/listening" })).toBe(state);
        expect(faceAfter(state, { type: "clip-ended", base: "/a/portrait/brokk/listening-to-thinking" })).toBe(state);
        expect(faceAfter(state, { type: "clip-ended", base: "/a/portrait/brokk/listening.smile" })).toBe(state);
        expect(faceAfter(state, { type: "clip-ended", base: "/a/portrait/brokk/listening.call" }).reaction).toBeNull();
    });

    it("hands it back at the cap for the gesture asked, and not for an older one", () => {
        const state = startFace({ play: smile });
        expect(faceAfter(state, { type: "reaction-expired", cue: 7 })).toBe(state);
        expect(faceAfter(state, { type: "reaction-expired", cue: 8 }).reaction).toBeNull();
        const none = startFace({});
        expect(faceAfter(none, { type: "reaction-expired", cue: 8 })).toBe(none);
    });

    it("stops speaking when the few seconds are over", () => {
        const state = startFace({ speaks: true });
        expect(faceAfter(state, { type: "speech-expired" }).speaking).toBe(false);
        const quiet = startFace({});
        expect(faceAfter(quiet, { type: "speech-expired" })).toBe(quiet);
    });
});
