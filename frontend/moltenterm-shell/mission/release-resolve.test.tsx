// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { originText, readOrigin } from "../reviews/agent-origin";
import { ReleaseFailureActions, ReleaseResolveActions, resolveText } from "./release-resolve";
import { Phase } from "./release-run";

const actions: ReleaseResolveActions = {
    rerunRuns: async () => {},
    resolve: async () => ({ result: { status: "started" }, tab: "Release v1" }),
};

function failed(extra: Partial<Phase> = {}): Phase {
    return {
        id: "prepare",
        title: "Prepare",
        status: "failed",
        expect: "",
        links: [],
        action: { kind: "prepare", label: "Retry the preparation" },
        failure: {
            step: "Promote develop",
            runid: "prep-1",
            runs: [{ name: "ci.yml", runid: 389, url: "https://github.com/acme/app/actions/runs/389" }],
        },
        ...extra,
    };
}

describe("a failed release step's ways out (#945)", () => {
    it("offers Rerun failed jobs, Analyze and resolve and Investigate together on a red trunk CI", () => {
        const html = renderToStaticMarkup(<ReleaseFailureActions phase={failed()} actions={actions} />);
        expect(html).toContain('data-testid="release-run-rerun-failed"');
        expect(html).toContain("Rerun failed jobs");
        expect(html).toContain("Analyze and resolve");
        expect(html).toContain("Investigate together");
        // Nothing starts before a click: no confirmation, no answer yet.
        expect(html).not.toContain("release-run-rerun-confirm");
        expect(html).not.toContain("release-run-resolve-said");
    });

    it("leaves the rerun to the build's own action, and needs a failure", () => {
        const build = renderToStaticMarkup(
            <ReleaseFailureActions
                phase={failed({ id: "build", action: { kind: "rerun", label: "Rerun the failed jobs" } })}
                actions={actions}
            />
        );
        expect(build).not.toContain("release-run-rerun-failed");
        expect(build).toContain("release-run-analyze");
        const noRuns = renderToStaticMarkup(
            <ReleaseFailureActions phase={failed({ failure: { step: "Cut", runs: [] } })} actions={actions} />
        );
        expect(noRuns).not.toContain("release-run-rerun-failed");
        expect(noRuns).toContain("release-run-together");
        expect(
            renderToStaticMarkup(<ReleaseFailureActions phase={failed({ status: "running" })} actions={actions} />)
        ).toBe("");
        expect(
            renderToStaticMarkup(<ReleaseFailureActions phase={failed({ failure: undefined })} actions={actions} />)
        ).toBe("");
    });

    it("says above the agent's terminal why it is there", () => {
        const origin = readOrigin({
            kind: "release",
            repo: "acme/app",
            number: 0,
            branch: "develop",
            tag: "v1.0.0-5",
            phase: "prepare",
            step: "Promote develop",
            mode: "background",
            at: Date.UTC(2026, 9, 22, 9, 5),
        });
        expect(originText(origin, t)).toMatch(
            /^Started by you at .+ to analyze and resolve the failed step Promote develop of the release v1\.0\.0-5$/
        );
        expect(originText({ ...origin, mode: "together" }, t)).toContain("with you, its logs beside");
    });

    it("says what started, or why nothing did", () => {
        expect(
            resolveText(t, { status: "started", agentname: "Claude Code" }, "background", "Promote", "Release v1")
        ).toEqual({
            text: "Claude Code looks into Promote out of sight: a notification tells you what it did and whether the step can be retried.",
            error: false,
        });
        expect(
            resolveText(t, { status: "started", agentname: "Codex" }, "together", "Promote", "Release v1").text
        ).toBe("Codex is in the “Release v1” tab, beside the failing logs.");
        expect(resolveText(t, { status: "noagent", message: "No coding agent" }, "background", "Promote", "x")).toEqual(
            {
                text: "The agent could not be started: No coding agent",
                error: true,
            }
        );
    });
});
