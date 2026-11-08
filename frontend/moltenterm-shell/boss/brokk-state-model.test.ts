// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { BrokkExpression, BrokkSituation } from "./brokk-ask-model";
import {
    BrokkExpressions,
    brokkPose,
    faceAfter,
    gestureEvent,
    reactionCapMs,
    restingPose,
    startFace,
} from "./brokk-state-model";
import Manifest from "./portrait/brokk/brokk-manifest.json";

function situation(partial: Partial<BrokkSituation> = {}): BrokkSituation {
    return { working: 0, waiting: 0, cardOpen: false, ...partial };
}

const NoFace = { speaking: false, expression: null as BrokkExpression };

describe("his pose from MoltenTerm's signals (FR-BOSS-007, AC2)", () => {
    it.each([
        ["nothing works, nothing waits, the card is closed: awake (#1958)", situation(), "listening"],
        ["the developer is away and nothing goes on: asleep", situation({ away: true }), "rest"],
        [
            "the developer is away with the card open and nothing going on: he looks up at whoever opened it (#1959)",
            situation({ away: true, cardOpen: true }),
            "listening",
        ],
        [
            "the developer is away while an agent works: he watches it",
            situation({ away: true, working: 1 }),
            "thinking",
        ],
        ["the developer is away and something arrived: awake", situation({ away: true, waiting: 1 }), "listening"],
        ["an agent works and nothing waits", situation({ working: 1 }), "thinking"],
        ["several agents work and nothing waits", situation({ working: 5 }), "thinking"],
        ["something waits for the developer", situation({ waiting: 1 }), "listening"],
        ["something waits while agents work", situation({ working: 3, waiting: 2 }), "listening"],
        [
            "a failure waits while an agent works (the badge counts it)",
            situation({ working: 1, waiting: 1 }),
            "listening",
        ],
        ["the card is open with nothing going on", situation({ cardOpen: true }), "listening"],
        [
            "the card is open while an agent works: he looks up, the developer came to talk to him (#1959)",
            situation({ cardOpen: true, working: 1 }),
            "listening",
        ],
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
        expect(brokkPose(situation(), speaking)).toBe("listening");
        expect(brokkPose(situation({ away: true }), speaking)).toBe("rest");
    });

    it("wakes when the developer comes back: the same signals without the absence listen again", () => {
        const asleep = situation({ away: true });
        expect(brokkPose(asleep, NoFace)).toBe("rest");
        expect(brokkPose({ ...asleep, away: false }, NoFace)).toBe("listening");
    });

    it("keeps rest for sleep alone: the manifest carries him out of it into listening (the wake clip)", () => {
        expect(Manifest.transitions).toContain("rest>listening");
    });
});

describe("speaking when the card opens while his face already shows (#1958)", () => {
    it("starts speaking on the ask, once, and lets the speech expire", () => {
        const quiet = startFace({});
        const speaking = faceAfter(quiet, { type: "speak" });
        expect(speaking.speaking).toBe(true);
        expect(faceAfter(speaking, { type: "speak" })).toBe(speaking);
        expect(faceAfter(speaking, { type: "speech-expired" }).speaking).toBe(false);
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

describe("what the package says of a gesture (FR-BOSS-007, AC17)", () => {
    it("hands the pose back at the end of a gesture, and does nothing at its start", () => {
        expect(gestureEvent("smile", "end")).toEqual({ type: "gesture-ended", name: "smile" });
        expect(gestureEvent("smile", "start")).toBeNull();
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

    it("hands the pose back when the gesture asked ends, and not for another gesture (a blink drawn by chance, say)", () => {
        const state = startFace({ play: call });
        expect(faceAfter(state, { type: "gesture-ended", name: "blink" })).toBe(state);
        expect(faceAfter(state, { type: "gesture-ended", name: "smile" })).toBe(state);
        expect(faceAfter(state, { type: "gesture-ended", name: "call" }).reaction).toBeNull();
        const none = startFace({});
        expect(faceAfter(none, { type: "gesture-ended", name: "call" })).toBe(none);
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
