// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { translate } from "../i18n/i18n-core";
import { originText, readOrigin } from "./agent-origin";
import { LeadResumeDialog, LeadResumeModel, PendingLeadResume } from "./lead-resume";

beforeAll(() => {
    vi.stubGlobal("document", { body: {} });
});

function pending(extra: Partial<PendingLeadResume> = {}): PendingLeadResume {
    return {
        number: 1772,
        name: "Arthur",
        agent: "Claude Code",
        folder: "/work/app",
        guessed: false,
        answer: vi.fn(),
        ...extra,
    };
}

function buttonTag(html: string, testId: string): string {
    return new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
}

describe("Resume with a lead that no longer runs (#1779, FR-REV-022 AC19)", () => {
    it("says who is gone and what resuming does, before anything starts", () => {
        const html = renderToStaticMarkup(<LeadResumeDialog pending={pending()} />);
        expect(html).toContain("Arthur is no longer running");
        expect(html).toContain("Pull request #1772");
        expect(html).toContain("Arthur (Claude Code) owns the work on #1772, but its session ended.");
        expect(html).toContain("in /work/app");
        expect(html).toContain("it delegates to a subagent and keeps its own turn short");
        expect(html).not.toContain("lead-resume-guessed");
    });

    it("says when the session is only the CLI's most recent one of the folder", () => {
        const html = renderToStaticMarkup(<LeadResumeDialog pending={pending({ guessed: true })} />);
        expect(html).toContain("MoltenTerm does not know Arthur&#x27;s session for sure");
        expect(html).toContain("Claude Code resumes its most recent session in that folder");
    });

    it("offers Cancel, New agent and a molten Resume {name}, in that order", () => {
        const html = renderToStaticMarkup(<LeadResumeDialog pending={pending()} />);
        expect(buttonTag(html, "lead-resume-cancel")).not.toContain("molten-btn");
        expect(buttonTag(html, "lead-resume-new")).not.toContain("molten-btn");
        expect(buttonTag(html, "lead-resume-start")).toContain("molten-btn");
        expect(html).toContain(">Resume Arthur<");
        expect(html).toContain(">New agent…<");
        expect(html.indexOf("lead-resume-cancel")).toBeLessThan(html.indexOf("lead-resume-new"));
        expect(html.indexOf("lead-resume-new")).toBeLessThan(html.indexOf("lead-resume-start"));
    });

    it("is worded in French", () => {
        expect(translate("fr", "reviews.lead.dialog.title", { name: "Arthur" })).toBe("Arthur ne tourne plus");
        expect(translate("fr", "reviews.lead.dialog.resume", { name: "Arthur" })).toBe("Reprendre Arthur");
        expect(translate("fr", "reviews.card.action.newAgent")).toBe("Nouvel agent");
    });
});

describe("LeadResumeModel (#1779)", () => {
    it("resolves with the developer's answer and closes", async () => {
        const model = LeadResumeModel.getInstance();
        const asked = model.ask({ number: 1, name: "Arthur", agent: "Claude Code", folder: "/p", guessed: false });
        globalStore.get(model.pendingAtom).answer("resume");
        await expect(asked).resolves.toBe("resume");
        expect(globalStore.get(model.pendingAtom)).toBeNull();
    });

    it("a second ask cancels the first, which starts nothing", async () => {
        const model = LeadResumeModel.getInstance();
        const first = model.ask({ number: 1, name: "Arthur", agent: "Claude Code", folder: "/p", guessed: false });
        const second = model.ask({ number: 2, name: "Bruno", agent: "Codex", folder: "/p", guessed: true });
        await expect(first).resolves.toBeNull();
        globalStore.get(model.pendingAtom).answer("new");
        await expect(second).resolves.toBe("new");
    });
});

describe("the resumed lead's terminal says why it opened (#758)", () => {
    it("names the lead resume in the origin line", () => {
        const origin = readOrigin({
            kind: "lead",
            repo: "acme/app",
            number: 1772,
            branch: "b",
            mode: "together",
            at: 1,
        });
        expect(origin).not.toBeNull();
        const en = (key: string, vars?: Record<string, any>) => translate("en", key, vars);
        expect(originText(origin, en, "en-GB")).toMatch(
            /^Started by you at .*: the lead agent's session resumed to take #1772 back$/
        );
    });
});
