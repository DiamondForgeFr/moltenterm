// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

const noop = () => {};

function textOutsideDetails(html: string): string {
    return html.replace(/<details[\s\S]*?<\/details>/g, "");
}

describe("EmptyState (FR-SHELL-053, DS-SHELL-094)", () => {
    it("draws the icon at 20 px, the title at 13/600 and the hint muted at 12", () => {
        const html = renderToStaticMarkup(<EmptyState icon="code-branch" title="Nothing here" hint="One sentence." />);
        expect(html).toContain("fa-code-branch");
        expect(html).toContain("text-icon-20");
        expect(html).toMatch(/text-13[^"]*font-semibold[^"]*"[^>]*>Nothing here/);
        expect(html).toMatch(/text-12[^"]*text-muted[^"]*">One sentence\./);
        expect(html).toContain("max-w-[360px]");
    });

    it("has one molten primary with its wave and a calm secondary", () => {
        const html = renderToStaticMarkup(
            <EmptyState
                icon="x"
                title="T"
                primary={{ label: "Do it", onClick: noop }}
                secondary={{ label: "Other", onClick: noop }}
            />
        );
        expect(html.match(/class="molten-btn /g)).toHaveLength(1);
        expect(html.match(/molten-btn-wave/g)).toHaveLength(1);
        expect(html).toContain("molten-btn-secondary");
        expect(html.indexOf("Do it")).toBeLessThan(html.indexOf("Other"));
    });

    it("marks a menu action and a running one", () => {
        const html = renderToStaticMarkup(
            <EmptyState
                icon="x"
                title="T"
                primary={{ label: "Attach", menu: true, onClick: noop }}
                secondary={{ label: "Start", busy: true, busyLabel: "Starting…", onClick: noop }}
            />
        );
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain("fa-chevron-down");
        expect(html).toContain("Starting…");
        expect(html).toContain('aria-busy="true"');
        expect(html).not.toContain(">Start<");
    });

    it("keeps raw output in a collapsed Details, never in the title or the hint (AC3)", () => {
        const raw = "git rev-parse --git-dir: fatal: not a git repository (or any of the parent directories): .git";
        const html = renderToStaticMarkup(
            <EmptyState
                icon="code-branch"
                title="This folder is not a git repository"
                hint="Initialize git."
                details={raw}
            />
        );
        expect(html).toContain("<details");
        expect(html).not.toContain("<details open");
        expect(html).toContain(">Details<");
        expect(html).toContain("fatal: not a git repository");
        expect(textOutsideDetails(html)).not.toContain("fatal");
        expect(html).toMatch(/<pre[^>]*font-mono[^>]*text-11/);
    });

    it("shows a failed action as an alert", () => {
        const html = renderToStaticMarkup(<EmptyState icon="x" title="T" alert="It did not start." details="boom" />);
        expect(html).toMatch(/role="alert"[^>]*>It did not start\./);
    });

    it("has no action row without actions", () => {
        const html = renderToStaticMarkup(<EmptyState icon="x" title="T" />);
        expect(html).not.toContain("<button");
    });
});

describe("the surfaces of FR-SHELL-053 use it", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

    it("companion, Mission Control and Sessions render EmptyState", () => {
        for (const file of [
            "./companion/companion-view.tsx",
            "./mission/mission-frame.tsx",
            "./sessions/sessions-view.tsx",
        ]) {
            expect(read(file), file).toContain('from "../empty-state"');
        }
    });

    it("Mission Control no longer prints git's error in its text", () => {
        expect(read("./mission/mission-frame.tsx")).not.toContain("reads the project's history from git: ${");
    });

    it("onboarding never says a step is not ready", () => {
        const src = read("../moltenterm-onboarding/onboarding-placeholder-steps.tsx");
        expect(src).not.toMatch(/not ready in this version/i);
    });
});
