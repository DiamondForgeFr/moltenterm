// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManualCheckFailure, PipelineReleaseStep } from "./mission-model";
import { ReleaseFacts, releaseRun } from "./release-run";
import { ReleaseRunPanel, UncoveredNote } from "./release-run-panel";

// The scope of a changelog section written by hand, and what a public one leaves out (#1142).

const steps: PipelineReleaseStep[] = [
    { id: "prepare", title: "Prepare", phase: "prepare", run: "molten release prepare {tag} --pr" },
    {
        id: "changelog-en",
        title: "Write the {version} section of docs/changelog.md",
        phase: "cut",
        manual: "Write the {version} section of docs/changelog.md.",
        run: undefined,
    },
    {
        id: "open-pr",
        title: "Open the pull request",
        phase: "cut",
        confirm: "Pushes.",
        run: "molten release open-pr {tag}",
    },
];

function facts(extra: Partial<ReleaseFacts> = {}): ReleaseFacts {
    return {
        session: { tag: "v1.1.0", version: "1.1.0", channel: "public", startedat: 1 },
        tag: "v1.1.0",
        version: "1.1.0",
        channel: "public",
        tagexists: false,
        steps: {},
        preparation: { runid: "p", state: "success", running: false, exit: 0, tail: [], phases: [] },
        runs: [],
        jobs: [],
        ontrunk: false,
        changelogscope: { since: "v1.0.1", steps: ["changelog-en"] },
        ...extra,
    };
}

const render = (f: ReleaseFacts) =>
    renderToStaticMarkup(
        <ReleaseRunPanel
            run={releaseRun(f, steps)}
            jobs={[]}
            actions={{ loadNotes: async () => "", saveNotes: async () => {}, run: async () => true }}
            lock={{ pending: "", run: async () => true }}
        />
    );

const cutOf = (f: ReleaseFacts) => releaseRun(f, steps).phases.find((p) => p.id === "cut");

describe("the scope of a changelog section (#1142)", () => {
    it("covers everything since the last public release for a public version, candidates included", () => {
        const f = facts();
        expect(cutOf(f).scope).toEqual({ since: "v1.0.1", public: true });
        const html = render(f);
        expect(html).toContain('data-testid="release-run-scope"');
        expect(html).toContain("Cover everything that changed since v1.0.1, release candidates included");
    });

    it("covers what changed since the previous release for a candidate", () => {
        const f = facts({
            session: { tag: "v1.1.0-2", version: "1.1.0", channel: "rc", startedat: 1 },
            tag: "v1.1.0-2",
            channel: "rc",
            changelogscope: { since: "v1.1.0-1", steps: ["changelog-en"] },
        });
        expect(cutOf(f).scope).toEqual({ since: "v1.1.0-1", public: false });
        const html = render(f);
        expect(html).toContain("Cover what changed since v1.1.0-1, the previous release, candidate or public.");
        expect(html).not.toContain("release candidates included");
    });

    it("names the public notes draft as the source when it is shown below", () => {
        const html = render(facts({ notes: "/r/app-release/releases/v1.1.0.md" }));
        expect(html).toContain("the public notes draft below already has this scope");
    });

    it("says nothing on a step that writes no changelog", () => {
        expect(cutOf(facts({ changelogscope: undefined })).scope).toBeUndefined();
        expect(render(facts({ changelogscope: { since: "v1.0.1", steps: [] } }))).not.toContain("release-run-scope");
    });
});

describe("what a public section leaves out (#1142)", () => {
    it("lists the changes it does not mention, since the last public release", () => {
        const failure: ManualCheckFailure = {
            path: "docs/changelog.md",
            contains: "1.1.0",
            dir: "/r/app-release",
            version: "1.1.0",
            since: "v1.0.1",
            uncovered: [
                { ticket: 21, text: "The crash on start" },
                { text: "Typo in the help" },
                ...Array.from({ length: 12 }, (_, i) => ({ ticket: 100 + i, text: `Change ${i}` })),
            ],
        };
        const html = renderToStaticMarkup(<UncoveredNote failure={failure} />);
        expect(html).toContain("The 1.1.0 section of docs/changelog.md does not mention these changes since v1.0.1:");
        expect(html).toContain("#21");
        expect(html).toContain("The crash on start");
        expect(html).toContain("Typo in the help");
        expect(html).toContain("and 2 more");
        expect(html).toContain("Leave them out only on purpose");
    });
});
