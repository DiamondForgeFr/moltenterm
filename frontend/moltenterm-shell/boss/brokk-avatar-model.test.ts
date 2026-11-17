// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokkExpression, restingPose } from "./brokk-ask-model";
import {
    AvatarPoses,
    avatarSituation,
    avatarVariant,
    brokkInitial,
    faceClickAction,
    FaceHoverCloseMs,
    FaceHoverIntent,
    FaceHoverOpenMs,
    hangingRightPx,
} from "./brokk-avatar-model";
import { BrokkPortrait, declarationForPoses } from "./brokk-portrait";
import { brokkPose, faceAfter, startFace } from "./brokk-state-model";

describe("where the avatar stands (FR-BOSS-009, AC1, AC14)", () => {
    it("is in the sidebar's row when the sidebar is on screen, on the strip of a collapsed one, and hangs from the window's edge only with no sidebar", () => {
        expect(avatarVariant("screen")).toBe("row");
        expect(avatarVariant("edge")).toBe("edge");
        expect(avatarVariant("none")).toBe("hanging");
    });

    it("hangs clear of the window controls the other platforms draw at the top right", () => {
        expect(hangingRightPx(false)).toBeGreaterThan(hangingRightPx(true));
    });

    it("thinks only while his own session works, never because other agents do", () => {
        expect(restingPose(avatarSituation(false))).toBe("listening");
        expect(restingPose(avatarSituation(true))).toBe("thinking");
        expect(avatarSituation(false).waiting).toBe(0);
        expect(avatarSituation(false).working).toBe(0);
    });
});

// A group as the store holds it: open or not, pinned or not. The intent opens it unpinned, as the hover does; a click
// (faceClickAction) pins it.
function makeGroup(canOpen = () => true) {
    const state = { open: false, pinned: false, opened: 0, closed: 0 };
    const intent = new FaceHoverIntent({
        isOpen: () => state.open,
        isPinned: () => state.pinned,
        canOpen,
        open: () => {
            state.open = true;
            state.pinned = false;
            state.opened++;
        },
        close: () => {
            state.open = false;
            state.pinned = false;
            state.closed++;
        },
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
    const click = () => {
        intent.cancel();
        const action = faceClickAction(state.open, state.pinned);
        if (action === "close") {
            state.open = false;
            state.pinned = false;
        } else {
            state.open = true;
            state.pinned = true;
        }
        return action;
    };
    return { state, intent, click };
}

describe("hovering the face opens his group (FR-BOSS-009, AC53, #2103)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("opens it once the pointer has rested on the face for the intent delay, unpinned", () => {
        const { state, intent } = makeGroup();
        intent.enterFace(false);
        vi.advanceTimersByTime(FaceHoverOpenMs - 1);
        expect(state.open).toBe(false);
        vi.advanceTimersByTime(1);
        expect(state.open).toBe(true);
        expect(state.pinned).toBe(false);
        expect(FaceHoverOpenMs).toBe(250);
    });

    it("opens nothing for a shorter pass over the face, on the way to the window buttons", () => {
        const { state, intent } = makeGroup();
        intent.enterFace(false);
        vi.advanceTimersByTime(FaceHoverOpenMs - 50);
        intent.leaveFace();
        vi.advanceTimersByTime(10 * FaceHoverOpenMs);
        expect(state.opened).toBe(0);
    });

    it("opens nothing while a button is held (a drag, a text selection) or while a menu or a dialog is open", () => {
        const pressed = makeGroup();
        pressed.intent.enterFace(true);
        vi.advanceTimersByTime(10 * FaceHoverOpenMs);
        expect(pressed.state.opened).toBe(0);

        let menu = true;
        const blocked = makeGroup(() => !menu);
        blocked.intent.enterFace(false);
        vi.advanceTimersByTime(FaceHoverOpenMs);
        expect(blocked.state.opened).toBe(0);
        menu = false;
        blocked.intent.leaveFace();
        blocked.intent.enterFace(false);
        vi.advanceTimersByTime(FaceHoverOpenMs);
        expect(blocked.state.opened).toBe(1);
    });
});

describe("a group opened by hover closes by itself until it is pinned (AC54)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function hoverOpened() {
        const group = makeGroup();
        group.intent.enterFace(false);
        vi.advanceTimersByTime(FaceHoverOpenMs);
        expect(group.state.open).toBe(true);
        return group;
    }

    it("closes once the pointer has left both the face and the group for the grace", () => {
        const { state, intent } = hoverOpened();
        intent.leaveFace();
        vi.advanceTimersByTime(FaceHoverCloseMs - 1);
        expect(state.open).toBe(true);
        vi.advanceTimersByTime(1);
        expect(state.open).toBe(false);
        expect(FaceHoverCloseMs).toBe(400);
    });

    it("never closes while the pointer moves from the face into the group, nor while it stays in the group", () => {
        const { state, intent } = hoverOpened();
        intent.leaveFace();
        vi.advanceTimersByTime(FaceHoverCloseMs - 100);
        intent.enterGroup();
        vi.advanceTimersByTime(10 * FaceHoverCloseMs);
        expect(state.open).toBe(true);
        intent.leaveGroup();
        intent.enterFace(false);
        vi.advanceTimersByTime(10 * FaceHoverCloseMs);
        expect(state.open).toBe(true);
        expect(state.opened).toBe(1);
        intent.leaveFace();
        vi.advanceTimersByTime(FaceHoverCloseMs);
        expect(state.open).toBe(false);
    });

    it("stays open whatever the pointer does once pinned by an interaction", () => {
        const { state, intent } = hoverOpened();
        intent.enterGroup();
        intent.leaveFace();
        // A press, the focus or typing in the group pins it (the store's pinCard).
        state.pinned = true;
        intent.leaveGroup();
        vi.advanceTimersByTime(10 * FaceHoverCloseMs);
        expect(state.open).toBe(true);
    });

    it("forgets the pointer over a group that left the page", () => {
        const { state, intent } = hoverOpened();
        intent.enterGroup();
        intent.groupGone();
        intent.leaveFace();
        vi.advanceTimersByTime(FaceHoverCloseMs);
        expect(state.open).toBe(false);
    });
});

describe("a click on the face (AC55)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("opens a closed group pinned, pins one the hover opened, and closes only a pinned one", () => {
        expect(faceClickAction(false, false)).toBe("open");
        expect(faceClickAction(true, false)).toBe("pin");
        expect(faceClickAction(true, true)).toBe("close");
    });

    it("keeps a hover-opened group open: the click pins it, and a second click closes it", () => {
        const { state, intent, click } = makeGroup();
        intent.enterFace(false);
        vi.advanceTimersByTime(FaceHoverOpenMs);
        expect(click()).toBe("pin");
        expect(state.open).toBe(true);
        intent.leaveFace();
        vi.advanceTimersByTime(10 * FaceHoverCloseMs);
        expect(state.open).toBe(true);
        intent.enterFace(false);
        expect(click()).toBe("close");
        expect(state.open).toBe(false);
        vi.advanceTimersByTime(10 * FaceHoverOpenMs);
        expect(state.open).toBe(false);
    });

    it("opens pinned before the intent delay, and the pending hover then does nothing more", () => {
        const { state, intent, click } = makeGroup();
        intent.enterFace(false);
        vi.advanceTimersByTime(FaceHoverOpenMs / 2);
        expect(click()).toBe("open");
        vi.advanceTimersByTime(10 * FaceHoverOpenMs);
        expect(state.pinned).toBe(true);
        expect(state.opened).toBe(0);
    });
});

describe("the gestures asked of him play on the folded avatar (FR-BOSS-009, AC1, #2219)", () => {
    const Gestures: BrokkExpression[] = ["call", "frown", "doubtful", "nod", "smile"];

    it("declares every gesture the app asks, to be played on demand, in the pose he rests in", () => {
        const declaration = declarationForPoses(BrokkPortrait, AvatarPoses);
        const listening = declaration.idles.listening ?? [];
        for (const gesture of Gestures) {
            expect(listening.find((idle) => idle.name === gesture)?.onDemand, gesture).toBe(true);
        }
    });

    it("gives a mounted face the reaction as soon as the gesture is asked, whether his session works or not", () => {
        for (const ownWorking of [false, true]) {
            const situation = avatarSituation(ownWorking);
            for (const [index, expression] of Gestures.entries()) {
                const asked = { expression, cue: index + 1, at: 0 };
                const mounted = startFace({ asked: null });
                const face = faceAfter(mounted, { type: "asked", asked });
                expect(face.reaction, `${expression} (working: ${ownWorking})`).toBe(asked);
                const pose = brokkPose(situation, { speaking: false, expression });
                expect(pose, expression).toBe("listening");
                expect(AvatarPoses).toContain(pose);
            }
        }
    });

    it("does not replay a gesture asked before the face was mounted, so that coming back shows none", () => {
        const asked = { expression: "call" as const, cue: 3, at: 0 };
        const mounted = startFace({ asked });
        expect(faceAfter(mounted, { type: "asked", asked })).toBe(mounted);
        expect(mounted.reaction).toBeNull();
    });
});

describe("the mark the avatar wears while his group is open (AC17, #2219)", () => {
    it("is the first letter of his name, in capitals, whatever the script", () => {
        expect(brokkInitial("Brokk")).toBe("B");
        expect(brokkInitial("  léa")).toBe("L");
        expect(brokkInitial("élodie")).toBe("É");
    });

    it("keeps a whole character when the name starts with one made of two code units", () => {
        expect(brokkInitial("🔥 Forge")).toBe("🔥");
    });

    it("falls back to the default name's initial for an empty name", () => {
        expect(brokkInitial("")).toBe("B");
        expect(brokkInitial("   ")).toBe("B");
        expect(brokkInitial(undefined)).toBe("B");
    });
});
