// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrokkPose } from "./brokk-ask-model";
import { BrokkCalm } from "./brokk-calm";

function draw(pose: BrokkPose, poster?: string): string {
    return renderToStaticMarkup(<BrokkCalm pose={pose} poster={poster} />);
}

// The tests run in a plain Node environment, which has no DOM parser: read the markup with patterns.
function videos(html: string): string[] {
    return html.match(/<video[^>]*>/g) ?? [];
}

function css(file: string): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("his face under reduced motion (FR-BOSS-009, AC1, #2224, AC-1)", () => {
    it("plays the loop of the pose, on its own, muted and endlessly", () => {
        const [loop] = videos(draw("listening"));
        expect(loop).toMatch(/src="[^"]*listening\.webm"/);
        expect(loop).toMatch(/autoPlay=""|autoplay=""/i);
        expect(loop).toMatch(/\sloop=""/);
        expect(loop).toMatch(/muted=""/);
    });

    it("lays a blink clip over the listening and the speaking loops, hidden until it plays", () => {
        for (const pose of ["listening", "speaking"] as const) {
            const list = videos(draw(pose));
            expect(list, pose).toHaveLength(2);
            expect(list[0], pose).toMatch(new RegExp(`src="[^"]*${pose}\\.webm"`));
            expect(list[1], pose).toMatch(new RegExp(`src="[^"]*${pose}\\.blink\\.webm"`));
            expect(list[1], pose).toContain('data-on="false"');
            expect(list[1], pose).not.toMatch(/\sloop=""|autoPlay=""|autoplay=""/i);
        }
    });

    it("has no blink in the poses that have no blink clip: the loop alone", () => {
        for (const pose of ["thinking", "rest"] as const) {
            const list = videos(draw(pose));
            expect(list, pose).toHaveLength(1);
            expect(list[0], pose).toMatch(new RegExp(`src="[^"]*${pose}\\.webm"`));
        }
    });

    it("draws no gesture and no clip between two poses, whatever the pose", () => {
        for (const pose of ["listening", "thinking", "speaking", "rest"] as const) {
            const html = draw(pose);
            expect(html, pose).not.toMatch(/\.(nod|doubtful|frown|smile|call)\.webm/);
            expect(html, pose).not.toMatch(/-to-/);
        }
    });

    it("shows the pose it was given, and names it for whoever reads the page", () => {
        expect(draw("thinking")).toMatch(
            /data-testid="brokk-calm"[^>]*data-pose="thinking"|data-pose="thinking"[^>]*data-testid="brokk-calm"/
        );
    });

    it("keeps a poster under the loop where no still lies under the face", () => {
        expect(videos(draw("listening", "/poster.jpg"))[0]).toContain('poster="/poster.jpg"');
        expect(videos(draw("listening"))[0]).not.toContain("poster=");
    });

    it("starts a new player for a new pose, so that its loop begins on its first frame and no clip joins the two", () => {
        const source = readFileSync(join(__dirname, "brokk-calm.tsx"), "utf8");
        expect(source).toMatch(/<CalmPlayer key=\{pose\}/);
    });

    it("moves nothing across the picture: no transition, no animation, no transform", () => {
        const sheet = css("brokk-calm.css");
        expect(sheet).not.toMatch(/transition|animation|@keyframes|transform/);
        expect(sheet).toMatch(/\.mt-brokk-calm-blink\[data-on="false"\] \{\s*opacity: 0;/);
    });
});
