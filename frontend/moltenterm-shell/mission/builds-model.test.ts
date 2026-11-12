// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildCardTitle, buildRunView, ciLine, deliveredBy, lastBuildLine, verifyLine } from "./builds-model";

describe("Build local menu (FR-MC-012)", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");

    it("says when the last build was made, or that there is none", () => {
        expect(lastBuildLine({ commit: "9c425c4abcdef", builtAt: "2026-10-03T11:54:00Z" }, now)).toBe(
            "Last: 6 minutes ago · 9c425c4"
        );
        expect(lastBuildLine({ commit: "9c425c4abcdef", builtAt: "2026-10-01T12:00:00Z" }, now)).toBe(
            "Last: 2 days ago · 9c425c4"
        );
        expect(lastBuildLine(null, now)).toBe("Never built");
    });

    it("says where the CI stands on the trunk", () => {
        expect(ciLine({ trunk: "develop", builds: [], ci: { status: "success", sha: "a" } })).toBe(
            "CI green on develop."
        );
        expect(
            ciLine({ trunk: "develop", builds: [], ci: { status: "failure", failed: ["check", "e2e"], sha: "a" } })
        ).toBe("CI red on develop (check, e2e): it runs again first, and the build stops if it fails.");
        expect(ciLine({ trunk: "develop", builds: [] }, "ci-local")).toBe("The local CI will run first on develop.");
    });

    it("does not promise the local CI to a build that accepts GitHub's (#2277)", () => {
        expect(ciLine({ trunk: "develop", builds: [] }, "ci")).toBe(
            "The CI will run first on develop: GitHub's if it already checked this commit in full, else the local one."
        );
    });

    it("names a card after the project and the build", () => {
        expect(buildCardTitle("MoltenTerm", { id: "gold", title: "Gold" })).toBe("MoltenTerm Gold");
        expect(buildCardTitle("Notulia", { id: "gold", title: "Notulia Gold" })).toBe("Notulia Gold");
        expect(buildCardTitle("P", { id: "rc" })).toBe("P rc");
    });
});

describe("Build run panel (FR-MC-013)", () => {
    const phases = [
        { id: "verify", title: "Verify", text: "The local CI on this commit." },
        { id: "build", title: "Build", text: "The app." },
        { id: "deliver", title: "Deliver", text: "Into the local builds folder." },
    ];
    const statuses = (v: ReturnType<typeof buildRunView>) => v.phases.map((p) => p.status).join(",");

    it("shows every declared phase from the start, the current one running with its text", () => {
        const before = buildRunView({ state: "running", phases: [], startedat: 0 }, phases, null);
        expect(statuses(before)).toBe("running,todo,todo");
        expect(before.line).toBe("The local CI on this commit.");
        const building = buildRunView({ state: "running", phases: ["verify", "build"], startedat: 0 }, phases, null);
        expect(statuses(building)).toBe("done,running,todo");
        expect(building.line).toBe("The app.");
    });

    it("says what was delivered, only when the manifest is this run's", () => {
        const manifest = {
            commit: "9c425c4abcdef",
            productName: "Notulia Gold",
            version: "1.0.0-8",
            builtAt: "2026-10-03T12:00:00Z",
            notes: Array(12).fill({}),
        };
        const run = {
            state: "success" as const,
            phases: ["verify", "build", "deliver"],
            startedat: Date.parse("2026-10-03T11:50:00Z"),
            commit: "9c425c4abcdef",
        };
        const view = buildRunView(run, phases, manifest);
        expect(statuses(view)).toBe("done,done,done");
        expect(view.line).toBe("Delivered: Notulia Gold 1.0.0-8, commit 9c425c4, 12 commit(s) since the previous one.");
        expect(view.showLog).toBe(false);
        expect(buildRunView({ ...run, commit: "other" }, phases, manifest).line).toBe("Built.");
        expect(deliveredBy({ ...run, startedat: Date.parse("2026-10-03T13:00:00Z") }, manifest)).toBeNull();
    });

    it("says where and why it stopped", () => {
        expect(buildRunView({ state: "failure", phases: ["verify", "build"], startedat: 0 }, phases, null).line).toBe(
            "Failed during “Build”. The end of the log says why."
        );
        expect(
            statuses(buildRunView({ state: "failure", phases: ["verify", "build"], startedat: 0 }, phases, null))
        ).toBe("done,failed,todo");
        expect(buildRunView({ state: "lost", phases: ["verify"], startedat: 0 }, phases, null).line).toBe(
            "Interrupted during “Verify”: its process is gone without an exit code."
        );
        expect(buildRunView({ state: "cancelled", phases: [], startedat: 0 }, phases, null).line).toBe(
            "Cancelled by you during “Verify”."
        );
    });

    it("says why when a time limit stopped it (#2273)", () => {
        const stalled = buildRunView(
            {
                state: "failure",
                phases: ["verify"],
                startedat: 0,
                stopped: "Stopped: the local CI made no progress for 10 minutes (tests).",
                stoppedtext: { code: "mission.build.stalled", vars: { minutes: "10", jobs: "tests" } },
            },
            phases,
            null
        );
        expect(stalled.line).toBe(
            "Stopped: the local CI made no progress for 10 minutes (tests). Relaunch the build: the jobs already green are reused."
        );
        expect(statuses(stalled)).toBe("failed,todo,todo");
    });

    it("says how the commit was verified, for the whole run (#2277)", () => {
        const base = { state: "running" as const, phases: ["verify", "build"], startedat: 0 };
        expect(buildRunView(base, phases, null).verification).toBe("");
        expect(
            buildRunView(
                { ...base, verify: { by: "github", runid: 123456, jobs: 6, sha: "69c7639", url: "https://x/run" } },
                phases,
                null
            ).verification
        ).toBe("Verified by GitHub CI · run 123456 · 6 jobs green on 69c7639");
        expect(verifyLine({ by: "github", runid: 7, jobs: 1, sha: "69c7639" })).toBe(
            "Verified by GitHub CI · run 7 · 1 job green on 69c7639"
        );
        expect(verifyLine({ by: "waiting", runid: 123456, done: 3, total: 6 })).toBe(
            "Waiting for GitHub CI · run 123456 · 3 of 6 jobs done"
        );
        expect(verifyLine({ by: "waiting", runid: 123456 })).toBe("Waiting for GitHub CI · run 123456");
    });

    it("words why GitHub's result was not used in the interface language, else as the server said it (#2277)", () => {
        expect(
            verifyLine({
                by: "local",
                why: "you are not signed in to GitHub (gh auth login)",
                whytext: { code: "mission.build.github.loggedOut" },
            })
        ).toBe("GitHub CI not used: you are not signed in to GitHub (gh auth login). The local CI runs.");
        expect(
            verifyLine({
                by: "local",
                why: "a reason of a newer wavesrv",
                whytext: { code: "mission.build.github.unknown" },
            })
        ).toBe("GitHub CI not used: a reason of a newer wavesrv. The local CI runs.");
    });

    it("falls back to the announced phases when the build declares none", () => {
        const view = buildRunView({ state: "running", phases: ["build", "deliver"], startedat: 0 }, [], null);
        expect(view.phases.map((p) => `${p.title}:${p.status}`).join(",")).toBe("Build:done,Deliver:running");
    });
});
