// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../mission/mission-client", () => ({ treePrs: vi.fn() }));

import { MergedPrMark, mergedPrMap, sessionMergedPr, treesOf } from "./merged-prs";
import type { DurableSession } from "./sessions-model";

const session = (id: string, extra: Partial<DurableSession>): DurableSession =>
    ({
        id,
        shortid: id,
        connection: "",
        connstate: "connected",
        workspaceorder: 0,
        shown: true,
        canshow: true,
        canend: true,
        ...extra,
    }) as DurableSession;

describe("the merged PR mark of the Sessions list (#932)", () => {
    const ci = session("j1", { worktree: { path: "/d/work-891", branch: "fix/890-dialog" } });
    const twin = session("j2", { worktree: { path: "/d/work-891", branch: "fix/890-dialog" } });
    const plain = session("j3", { folder: "/p" });
    const remote = session("j4", { connection: "host", worktree: { path: "/r/w", branch: "feature/1-x" } });
    const noBranch = session("j5", { worktree: { path: "/d/detached" } });

    it("asks once per local worktree branch", () => {
        expect(treesOf([ci, twin, plain, remote, noBranch])).toEqual([
            { path: "/d/work-891", branch: "fix/890-dialog" },
        ]);
    });

    it("finds a session's merged PR, and none for the others", () => {
        const merged = mergedPrMap([
            { path: "/d/work-891", branch: "fix/890-dialog", pr: 891 },
            { path: "/r/w", branch: "feature/1-x", pr: 0 },
        ]);
        expect(sessionMergedPr(ci, merged)).toBe(891);
        expect(sessionMergedPr(twin, merged)).toBe(891);
        expect(sessionMergedPr(plain, merged)).toBe(0);
        expect(sessionMergedPr(remote, merged)).toBe(0);
    });

    it("shows PR #N merged next to the branch chip, and nothing without a merged PR", () => {
        const html = renderToStaticMarkup(<MergedPrMark session={ci} pr={891} />);
        expect(html).toContain("PR #891 merged");
        expect(html).toContain("fa-code-merge");
        expect(html).toContain("rounded-4 border");
        expect(html).toContain("The pull request #891 of fix/890-dialog is merged");
        expect(renderToStaticMarkup(<MergedPrMark session={plain} pr={0} />)).toBe("");
    });
});
