// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    checkIconState,
    CiIcon,
    CiIconClasses,
    CiIconState,
    githubRunIconState,
    LocalCiIcon,
    localCiIconState,
} from "./ci-icon";
import { CiStatus } from "./ci-model";
import { ActionRowClass, RowActionsClass } from "./ci-row-actions";

const States = Object.keys(CiIconClasses) as CiIconState[];

function glyph(state: CiIconState): string {
    return CiIconClasses[state].split(" ").find((c) => c.startsWith("fa-") && c !== "fa-spin");
}

describe("CI/CD state icons (FR-SHELL-057 AC4, NFR-SHELL-026)", () => {
    it("draws every state with a shape of its own, not a colour alone", () => {
        const glyphs = States.map(glyph);
        expect(new Set(glyphs).size).toBe(States.length);
        expect(glyph("success")).toBe("fa-check");
        expect(glyph("failure")).toBe("fa-xmark");
        expect(glyph("queued")).toBe("fa-clock");
        expect(glyph("running")).toBeUndefined();
        expect(glyph("neutral")).toBe("fa-minus");
    });

    it("is 14 px and labelled; a running state shows the falling dominoes (#739)", () => {
        expect(renderToStaticMarkup(<CiIcon state="queued" />)).toContain("text-icon-14");
        const html = renderToStaticMarkup(<CiIcon state="running" />);
        expect(html).toContain('aria-label="running"');
        expect(html).toContain('role="img"');
        expect(html).toContain('class="df-domino-loader mt-dominos-icon" aria-hidden="true"');
        expect(html).not.toContain("fa-");
    });

    it("tells a queued GitHub run from a running one", () => {
        expect(githubRunIconState("queued", "")).toBe("queued");
        expect(githubRunIconState("waiting", "")).toBe("queued");
        expect(githubRunIconState("in_progress", "")).toBe("running");
        expect(githubRunIconState("completed", "success")).toBe("success");
        expect(githubRunIconState("completed", "failure")).toBe("failure");
        expect(githubRunIconState("completed", "timed_out")).toBe("failure");
        expect(githubRunIconState("completed", "cancelled")).toBe("neutral");
        expect(githubRunIconState("completed", "skipped")).toBe("neutral");
        expect(githubRunIconState("completed", "action_required")).toBe("warning");
    });

    it("draws the dominoes for a running local run or job and for no other state (#1073)", () => {
        const statuses: CiStatus[] = ["running", "success", "failure", "queued", "cancelled", "interrupted"];
        for (const status of statuses) {
            const html = renderToStaticMarkup(<LocalCiIcon status={status} />);
            const dominoes = (html.match(/<span><\/span>/g) ?? []).length;
            expect(dominoes, status).toBe(status === "running" ? 8 : 0);
            expect(html.includes("df-domino-loader"), status).toBe(status === "running");
        }
    });

    it("maps the local CI's and the checks' states", () => {
        expect(localCiIconState("cancelled")).toBe("neutral");
        expect(localCiIconState("interrupted")).toBe("warning");
        expect(localCiIconState("queued")).toBe("queued");
        expect(checkIconState("pending")).toBe("running");
        expect(checkIconState("neutral")).toBe("neutral");
    });
});

describe("CI/CD row actions (FR-SHELL-057 AC4, NFR-SHELL-027)", () => {
    it("appear on the row's hover and on focus inside it, with the fast token", () => {
        expect(RowActionsClass).toContain("opacity-0");
        expect(RowActionsClass).toContain("group-hover:opacity-100");
        expect(RowActionsClass).toContain("group-focus-within:opacity-100");
        expect(RowActionsClass).toContain("pointer-events-none");
        expect(RowActionsClass).toContain("duration-120");
        expect(RowActionsClass).toContain("ease-mt");
        expect(ActionRowClass).toContain("group");
        expect(ActionRowClass).toContain("focus-within:bg-hover");
    });
});
