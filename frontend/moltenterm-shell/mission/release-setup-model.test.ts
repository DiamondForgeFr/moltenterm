// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    addManual,
    diffHunks,
    flowModel,
    lineDiff,
    needsReleaseSetup,
    removeManual,
    SetupDraft,
    SetupOptions,
    stepIdOf,
    toggled,
    validTagPrefix,
} from "./release-setup-model";

const options: SetupOptions = {
    kind: "on-premise",
    channels: ["rc", "public"],
    branchmodel: "promote",
    merge: "merge",
    tagprefix: "v",
    rcformat: "numeric",
    changelogs: [],
    ciworkflows: ["test.yml"],
    dispatch: [],
    notes: false,
    notespath: "releases/{tag}.md",
    syncback: true,
    milestone: true,
    manual: [],
    environments: [],
    reconcile: false,
    labels: [],
};

function draft(over: Partial<SetupDraft> = {}): SetupDraft {
    return {
        provider: "moltenterm",
        warnings: [],
        facts: {
            name: "P",
            haspipeline: true,
            missing: ["rc", "public"],
            branches: { trunk: "develop", release: "master" },
            tagprefix: "v",
            versionsdeclared: true,
            versionsource: { code: "versionsDeclared" },
            notesdeclared: false,
            notespath: "releases/{tag}.md",
            notesfound: false,
            changelogs: [],
            workflows: [
                { file: "deploy-docs.yml", push: false, dispatch: true, role: "docs", environments: ["github-pages"] },
            ],
            targets: [],
            ongithub: true,
            kind: "on-premise",
            kindevidence: [],
            saasfoundry: true,
            ticketbranches: true,
            releaseworktree: "../P-release",
            labels: [],
        },
        defaults: options,
        options,
        rcformats: [],
        branchmodels: [],
        merges: [],
        deploytargets: [],
        tagworkflows: {
            rc: [],
            public: [{ file: "publish-stable.yml", name: "Publish", environments: ["npm-production"] }],
        },
        proposal: {
            release: {
                public: [
                    { id: "promote", title: "Promote", phase: "prepare", run: "molten release promote" },
                    { id: "prepare", title: "Prepare", phase: "prepare", run: "molten release prepare {tag}" },
                    {
                        id: "merge-ours",
                        title: "Merge ours",
                        phase: "cut",
                        manual: "git merge -s ours",
                        run: undefined,
                    },
                    { id: "finalize", title: "Cut", phase: "cut", run: "molten release finalize {tag}" },
                    {
                        id: "dispatch-deploy-docs",
                        title: "Docs",
                        phase: "publish",
                        run: "molten release dispatch deploy-docs.yml --ref {tag}",
                    },
                    { id: "sync-back", title: "Back", phase: "back", run: "molten release sync-back {tag}" },
                ],
            },
            sources: { "public/promote": { code: "branches" } },
        },
        current: "",
        base: "",
        proposed: "",
        errors: [],
        validatewarnings: [],
        pr: null,
        ...over,
    };
}

describe("release setup model (FR-MC-036)", () => {
    it("is offered when a channel has no steps", () => {
        expect(needsReleaseSetup([], [{}])).toBe(true);
        expect(needsReleaseSetup([{}], [{}])).toBe(false);
        expect(needsReleaseSetup(null, null)).toBe(true);
    });

    it("diffs lines and folds the unchanged ones", () => {
        const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
        const after = "a\nb\nc\nd\ne\nf\ng\nX\nh\n";
        const rows = lineDiff(before, after);
        expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["X"]);
        expect(rows.filter((r) => r.kind === "del")).toHaveLength(0);
        const hunks = diffHunks(rows, 1);
        expect(hunks[0]).toEqual({ kind: "fold", count: 6 });
        expect(lineDiff("", "x\n")).toEqual([{ kind: "add", text: "x", newNo: 1 }]);
    });

    it("lays the flow out by phase, with the tag, the workflows and their approvals", () => {
        const model = flowModel(draft(), "public", "v");
        expect(model.promote).toBe(true);
        expect(model.syncBack).toBe(true);
        const byKey = Object.fromEntries(model.nodes.map((n) => [n.key, n]));
        expect(byKey["public/merge-ours"].kind).toBe("manual");
        expect(byKey["public/dispatch-deploy-docs"]).toMatchObject({
            kind: "dispatch",
            lane: "github",
            approval: "github-pages",
        });
        expect(byKey["public/@tag"].label).toBe("vX.Y.Z");
        expect(byKey["public/@wf/publish-stable.yml"]).toMatchObject({ phase: "build", approval: "npm-production" });
        expect(byKey["public/promote"]).toMatchObject({ lane: "trunk", source: { code: "branches" } });
    });

    it("adds manual steps with free ids and removes them", () => {
        let o = addManual(
            options,
            { title: "Merge -s ours", text: "git merge -s ours origin/master", channel: "rc", before: "promote" },
            ["merge-s-ours"]
        );
        expect(o.manual[0].id).toBe("merge-s-ours-2");
        o = removeManual(o, "merge-s-ours-2");
        expect(o.manual).toEqual([]);
        expect(stepIdOf("  !!  ")).toBe("manual");
    });

    it("checks prefixes and toggles lists", () => {
        expect(validTagPrefix("v")).toBe(true);
        expect(validTagPrefix("release-")).toBe(true);
        expect(validTagPrefix("1")).toBe(false);
        expect(toggled(["a"], "b", true)).toEqual(["a", "b"]);
        expect(toggled(["a", "b"], "a", false)).toEqual(["b"]);
    });
});
