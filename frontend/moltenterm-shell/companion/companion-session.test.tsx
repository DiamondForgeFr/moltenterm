// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanionCandidate, CompanionView } from "./companion-model";
import { CompanionSessions } from "./companion-session-store";
import { GuessNotice, SessionBar, SessionHistoryList } from "./companion-session-ui";

vi.mock("@/app/store/global", () => ({ openLink: vi.fn() }));

const noop = () => {};
const now = Date.now();

const guessed: CompanionView = {
    blockid: "b",
    version: 1,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    usage: { pageurl: "https://claude.ai/settings/usage", pagename: "Claude usage" },
    session: {
        path: "/s/a.jsonl",
        linkedby: "guessed",
        guess: "started",
        title: "fix the login tests",
        started: now - 60_000,
    },
};

describe("the companion's session bar (DS-SHELL-060)", () => {
    it("names the session and its start, marks a guess and offers the history", () => {
        const html = renderToStaticMarkup(<SessionBar view={guessed} onHistory={noop} />);
        expect(html).toContain("fix the login tests");
        expect(html).toMatch(/started \d{2}:\d{2}/);
        expect(html).toContain("guessed");
        expect(html).toContain('aria-label="Session history"');
        expect(html).toContain("fa-clock-rotate-left");
    });

    it("says a hook link plainly", () => {
        const html = renderToStaticMarkup(
            <SessionBar view={{ ...guessed, session: { ...guessed.session, linkedby: "hook" } }} onHistory={noop} />
        );
        expect(html).toContain("linked by the agent&#x27;s hook");
        expect(html).not.toContain(">guessed<");
    });

    it("explains a guess and offers another session, never for a hook link", () => {
        const html = renderToStaticMarkup(<GuessNotice session={guessed.session} onHistory={noop} />);
        expect(html).toContain("started after this terminal");
        expect(html).toContain("Not this session?");
        expect(renderToStaticMarkup(<GuessNotice session={{ path: "p", linkedby: "hook" }} onHistory={noop} />)).toBe(
            ""
        );
    });
});

describe("the session history", () => {
    const sessions: CompanionCandidate[] = [
        { path: "/s/a.jsonl", prompt: "fix the login tests", started: now - 60_000, current: true },
        {
            path: "/s/b.jsonl",
            prompt: "write the docs",
            started: now - 120_000,
            modified: now - 30_000,
            elsewhere: true,
        },
        { path: "/s/c.jsonl", command: "/clear" },
    ];

    it("lists the current session first, marked This terminal", () => {
        const html = renderToStaticMarkup(
            <SessionHistoryList sessions={sessions} error={null} now={now} onPick={noop} onClose={noop} />
        );
        expect(html.indexOf("fix the login tests")).toBeLessThan(html.indexOf("write the docs"));
        expect(html.match(/This terminal/g)).toHaveLength(1);
        expect(html).toContain('data-testid="companion-history-current"');
        expect(html).toContain("guessed by another terminal");
        expect(html).toContain("/clear");
        expect(html).toContain('aria-label="Back to the session"');
    });

    it("says when there is nothing to choose", () => {
        const html = renderToStaticMarkup(
            <SessionHistoryList sessions={[]} error={null} now={now} onPick={noop} onClose={noop} />
        );
        expect(html).toContain("No session of this folder");
    });
});

describe("the session store the agent label reads", () => {
    it("keeps each terminal's session until its companion closes", () => {
        const store = CompanionSessions.getInstance();
        store.set("t1", guessed.session);
        expect(globalStore.get(store.sessionAtom("t1"))?.title).toBe("fix the login tests");
        expect(globalStore.get(store.sessionAtom("t2"))).toBeNull();
        store.set("t1", null);
        expect(globalStore.get(store.sessionAtom("t1"))).toBeNull();
    });
});
