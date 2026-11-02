// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A Reviews card's local CI that nothing runs (#1713): Run again asks for the approval first when the commands wait for
// it, and never runs after the developer closed the sheet.

import { describe, expect, it } from "vitest";
import { approveCommands, LocalCiDeps, runLocalCiAgain } from "./reviews-local-ci";

const Untrusted = { untrusted: { hash: "h", commands: [] } };
const Started = { run: { id: "r1" } as any };

function deps(results: any[], approval: any) {
    const calls: string[] = [];
    const d: LocalCiDeps = {
        run: async (dir, branch) => {
            calls.push(`run ${dir} ${branch}`);
            return results.shift();
        },
        approve: async (dir) => {
            calls.push(`approve ${dir}`);
            return approval;
        },
    };
    return { d, calls };
}

describe("runLocalCiAgain", () => {
    it("runs the PR's branch when the commands are trusted", async () => {
        const { d, calls } = deps([Started], null);
        expect(await runLocalCiAgain("/p", "feature/1115-x", d)).toBeNull();
        expect(calls).toEqual(["run /p feature/1115-x"]);
    });

    it("asks for the approval, then runs once approved", async () => {
        const { d, calls } = deps([Untrusted, Started], { ok: true, resolve: true });
        expect(await runLocalCiAgain("/p", "b", d)).toBeNull();
        expect(calls).toEqual(["run /p b", "approve /p", "run /p b"]);
    });

    it("runs nothing when the sheet is closed without approving", async () => {
        const { d, calls } = deps([Untrusted, Started], { ok: true });
        expect(await runLocalCiAgain("/p", "b", d)).toBeNull();
        expect(calls).toEqual(["run /p b", "approve /p"]);
    });

    it("tells why when the run does not start", async () => {
        const failing: LocalCiDeps = {
            run: async () => {
                throw new Error("a local CI run is in progress (r0)");
            },
            approve: async () => ({ ok: true }),
        };
        expect(await runLocalCiAgain("/p", "b", failing)).toEqual({ error: "a local CI run is in progress (r0)" });
        const { d } = deps([{}], null);
        expect(await runLocalCiAgain("/p", "b", d)).toEqual({ key: "reviews.card.ciRun.notStarted" });
    });
});

describe("approveCommands", () => {
    it("opens the approve-only sheet and says only what failed", async () => {
        const { d, calls } = deps([], { ok: true, resolve: true });
        expect(await approveCommands("/p", d)).toBeNull();
        expect(calls).toEqual(["approve /p"]);
        const { d: broken } = deps([], { ok: false, error: "no project" });
        expect(await approveCommands("/p", broken)).toEqual({ error: "no project" });
    });
});
