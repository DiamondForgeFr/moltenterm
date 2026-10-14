// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanionCandidate, CompanionView, historyGroups, sessionRelation } from "./companion-model";
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

    it("shows the model and effort beside the agent, and nothing when unknown (#549)", () => {
        const html = renderToStaticMarkup(<SessionBar view={guessed} modelEffort="Opus · high" onHistory={noop} />);
        expect(html).toContain('data-testid="companion-model-effort">Opus · high<');
        expect(renderToStaticMarkup(<SessionBar view={guessed} onHistory={noop} />)).not.toContain(
            "companion-model-effort"
        );
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

describe("a terminal's sessions over time (#600)", () => {
    const view: CompanionView = {
        ...guessed,
        session: { path: "/p/c.jsonl", linkedby: "hook", title: "after the clear", started: now - 60_000 },
        earlier: [
            { path: "/p/b.jsonl", title: "before the clear", started: now - 7_200_000 },
            { path: "/p/a.jsonl", title: "first run" },
        ],
    };

    it("counts the earlier sessions on the history button, nothing when there are none", () => {
        const html = renderToStaticMarkup(<SessionBar view={view} onHistory={noop} />);
        expect(html).toContain('data-testid="companion-earlier-count">2<');
        expect(html).toContain("2 earlier sessions in this terminal");
        expect(html).not.toContain("Earlier session<");
        expect(renderToStaticMarkup(<SessionBar view={guessed} onHistory={noop} />)).not.toContain(
            "companion-earlier-count"
        );
    });

    it("flags an earlier session the user chose and offers the way back", () => {
        const earlier = { ...view, session: { ...view.session, linkedby: "picked" as const, earlier: true } };
        const html = renderToStaticMarkup(<SessionBar view={earlier} onHistory={noop} onBackToCurrent={noop} />);
        expect(html).toContain("Earlier session");
        expect(html).toContain('data-testid="companion-back-to-current"');
    });

    it("tells the session shown, an earlier one and another apart, by session id", () => {
        expect(sessionRelation("/real/p/c.jsonl", view)).toBe("current");
        expect(sessionRelation("/p/b.jsonl", view)).toBe("earlier");
        expect(sessionRelation("/p/z.jsonl", view)).toBe("other");
        expect(sessionRelation("", view)).toBe("");
        expect(sessionRelation("/p/c.jsonl", { ...view, session: { ...view.session, earlier: true } })).toBe("earlier");
    });

    it("groups the history: the session shown, the terminal's earlier ones, the folder's others", () => {
        const list: CompanionCandidate[] = [
            { path: "/p/c.jsonl", prompt: "after the clear", current: true },
            { path: "/p/b.jsonl", prompt: "before the clear", earlier: true },
            { path: "/p/x.jsonl", prompt: "another pane's work" },
        ];
        expect(historyGroups(list).map((g) => g.key)).toEqual(["current", "earlier", "other"]);
        const html = renderToStaticMarkup(
            <SessionHistoryList sessions={list} error={null} now={now} onPick={noop} onClose={noop} />
        );
        expect(html.indexOf("Earlier in this terminal")).toBeLessThan(html.indexOf("Other sessions of this folder"));
        expect(html.indexOf("before the clear")).toBeLessThan(html.indexOf("another pane&#x27;s work"));
        expect(html).toContain('data-testid="companion-history-earlier"');
        expect(historyGroups([{ path: "/p/x.jsonl" }]).map((g) => g.key)).toEqual(["other"]);
    });

    it("keeps the agent's own session apart while an earlier one shows", () => {
        const shown = {
            ...view,
            session: { ...view.session, path: "/p/b.jsonl", earlier: true, livepath: "/p/c.jsonl" },
        };
        expect(sessionRelation("/p/c.jsonl", shown)).toBe("current");
        expect(sessionRelation("/p/b.jsonl", shown)).toBe("earlier");
        const list: CompanionCandidate[] = [
            { path: "/p/b.jsonl", prompt: "before the clear", current: true, earlier: true },
            { path: "/p/c.jsonl", prompt: "after the clear", live: true },
            { path: "/p/a.jsonl", prompt: "first run", earlier: true },
        ];
        expect(historyGroups(list).map((g) => g.key)).toEqual(["current", "live", "earlier"]);
        const html = renderToStaticMarkup(
            <SessionHistoryList sessions={list} error={null} now={now} onPick={noop} onClose={noop} />
        );
        expect(html).toContain("The agent&#x27;s session now");
        expect(html).toContain('data-testid="companion-history-live"');
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
