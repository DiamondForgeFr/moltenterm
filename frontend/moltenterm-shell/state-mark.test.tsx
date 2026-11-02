// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RailColours, ToneMarks } from "./reviews/reviews-card";
import { cardState, CardStateKinds, type CardTone } from "./reviews/reviews-card-model";
import { StateMark, StateMarkKinds } from "./state-mark";

describe("StateMark (FR-SHELL-116)", () => {
    it.each(StateMarkKinds)("draws %s with its own shape class", (kind) => {
        const html = renderToStaticMarkup(<StateMark kind={kind} />);
        expect(html).toContain(`class="mt-state-mark is-${kind}`);
        expect(html).toContain('aria-hidden="true"');
    });

    it("turns only the running arc, on the working beat", () => {
        expect(renderToStaticMarkup(<StateMark kind="running" />)).toContain("mt-beat-turn");
        for (const kind of StateMarkKinds.filter((k) => k !== "running")) {
            expect(renderToStaticMarkup(<StateMark kind={kind} />)).not.toContain("mt-beat-turn");
        }
    });

    it("names itself when given a label", () => {
        const html = renderToStaticMarkup(<StateMark kind="blocked" label="Blocked: 1 pull request" />);
        expect(html).toContain('role="img"');
        expect(html).toContain('aria-label="Blocked: 1 pull request"');
        expect(html).not.toContain("aria-hidden");
    });
});

describe("Integration cards by heat (FR-SHELL-116)", () => {
    it("gives every card tone a state shape and an edge", () => {
        const tones: CardTone[] = ["ready", "you", "agent", "broken", "running", "draft", "wait"];
        for (const tone of tones) {
            expect(StateMarkKinds).toContain(ToneMarks[tone]);
            expect(RailColours[tone]).toMatch(/var\(--mt-/);
        }
    });

    it("takes the mockup's edges: ember blocked, patina ready, incandescent at 60 % what runs, a line a draft", () => {
        expect(RailColours.broken).toBe("var(--mt-state-blocked)");
        expect(RailColours.ready).toBe("var(--mt-state-ready)");
        expect(RailColours.running).toBe("color-mix(in srgb, var(--mt-state-running) 60%, transparent)");
        expect(RailColours.agent).toBe(RailColours.running);
        expect(RailColours.draft).toBe("var(--mt-line-2)");
        expect(RailColours.you).toBe("var(--mt-state-waiting)");
        expect(Object.values(RailColours).join(" ")).not.toMatch(/--mt-(accent|action)/);
    });

    it("reads every card state into a tone the edges and marks know", () => {
        expect(CardStateKinds.length).toBeGreaterThan(0);
        const pr = { number: 1, title: "t", branch: "feature/1-x", base: "develop", ci: { state: "pending" } };
        const running = cardState({ pr: pr as never, agents: [] });
        expect(running.kind).toBe("ci-running");
        expect(running.tone).toBe("running");
    });
});
