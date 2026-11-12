// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
vi.mock("../suite/suite", () => ({ DominoLoader: () => <span data-testid="mock-domino" /> }));
vi.mock("../tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: () => ({}),
}));
vi.mock("../companion/companion-task-model", () => ({ agentName: (id: string) => `Agent ${id}` }));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const nameAtom = atom("Brokk");
    return { BossBubbleModel: { getInstance: () => ({ nameAtom }) } };
});
const gate = vi.hoisted(() => ({ allowed: false }));
vi.mock("../build/current-build", () => ({ currentBrainstormAllowed: () => gate.allowed }));
vi.mock("../sessions/pane-focus", () => ({ showPane: vi.fn() }));
vi.mock("../settings/settings-open", () => ({ openSettingsSection: vi.fn() }));
vi.mock("./brokk-session", async () => {
    const { atom } = await import("jotai");
    const stateAtom = atom({ phase: "idle", reason: "", agentName: "", started: false, reply: "", where: null });
    const exchangeAtom = atom([] as any[]);
    const permissionAtom = atom(null as any);
    const permissionGoneAtom = atom(false);
    const approvedAtom = atom([] as any[]);
    const queuedAtom = atom(null as any);
    const returnedAtom = atom(null as string);
    const session = {
        stateAtom,
        exchangeAtom,
        permissionAtom,
        permissionGoneAtom,
        approvedAtom,
        queuedAtom,
        returnedAtom,
        cancelQueued: vi.fn(),
        takeReturned: vi.fn(() => null),
        say: vi.fn(),
        permit: vi.fn(),
        clearNote: vi.fn(),
        setWindowOpen: vi.fn(),
    };
    return { BrokkSession: { getInstance: () => session } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BrainstormLastLeftAtom, BrainstormStateAtom } from "../brainstorm/brainstorm-boot";
import { UsageReadingsAtom } from "./boss-usage";
import { BrokkSession } from "./brokk-session";
import { BrokkTalk, keepDraft } from "./brokk-talk";
import { BrokkUsageTab } from "./brokk-usage-tab";

const Now = Date.now();

beforeEach(() => {
    keepDraft("");
    globalStore.set((BrokkSession.getInstance() as any).exchangeAtom, []);
    globalStore.set(UsageReadingsAtom, {});
    globalStore.set((BrokkSession.getInstance() as any).stateAtom, {
        phase: "idle",
        reason: "",
        agentName: "",
        started: false,
        reply: "",
        where: null,
    });
});

describe("the Usage tab (FR-BOSS-009, AC9; FR-BOSS-006)", () => {
    it("says in one line that nothing shares a reading yet", () => {
        const html = renderToStaticMarkup(<BrokkUsageTab />);
        expect(html).toContain('data-testid="brokk-usage-empty"');
        expect(html).toContain("No plan usage to show yet");
    });

    it("lists each provider with its plan and a bar per window, the fullest first", () => {
        globalStore.set(UsageReadingsAtom, {
            codex: {
                agent: "codex",
                source: "t",
                readat: Now,
                windows: [{ id: "w", label: "5h", usedpercent: 20 }],
            },
            claude: {
                agent: "claude",
                source: "t",
                plan: "Max",
                readat: Now,
                windows: [
                    { id: "a", label: "5h", usedpercent: 45 },
                    { id: "b", label: "7d", usedpercent: 96 },
                ],
            },
        });
        const html = renderToStaticMarkup(<BrokkUsageTab />);
        expect([...html.matchAll(/data-provider="([^"]+)"/g)].map((m) => m[1])).toEqual(["claude", "codex"]);
        expect(html).toContain("Agent claude");
        expect(html).toContain(">Max<");
        expect(html.match(/data-testid="brokk-usage-row"/g)).toHaveLength(3);
        expect(html).toMatch(/data-testid="brokk-usage-row" data-level="error"/);
    });
});

describe("the field to talk to him (FR-BOSS-009, AC9 and AC15)", () => {
    function render(): string {
        return renderToStaticMarkup(<BrokkTalk onTyping={() => {}} />);
    }

    it("is named for him, with a Send that waits for a message", () => {
        const html = render();
        expect(html).toContain('data-testid="brokk-talk-input"');
        expect(html).toContain('placeholder="Write to Brokk…"');
        expect(html).toContain('aria-label="Message to Brokk"');
        expect(html).toMatch(/data-testid="brokk-talk-send"[^>]*>Send/);
        expect(html).toMatch(/<button type="submit" disabled=""/);
        expect(html).not.toContain('data-testid="brokk-talk-note"');
    });

    // #2237: one endless line hid the message being typed.
    it("is a field that wraps its lines, says its keys, and sends on Enter but not on Shift+Enter", () => {
        const html = render();
        expect(html).toMatch(/<textarea rows="1"[^>]*data-testid="brokk-talk-input"/);
        expect(html).toContain('title="Enter to send, Shift+Enter for a new line"');
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(source).toMatch(/onKeyDown=\{\(e\) => \{\s*if \(!sendsOnKey\(/);
        expect(source).toContain("talkFieldHeight(field.scrollHeight");
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).toMatch(/\.mt-brokk-field-input \{[^}]*resize: none;[^}]*white-space: pre-wrap;/);
        expect(css).toMatch(/\.mt-brokk-field\[data-open="true"\] \.mt-brokk-field-row \{[^}]*height: auto;/);
    });

    it("wears the Molten call to action", () => {
        expect(render()).toMatch(/class="molten-btn [^"]*"[^>]*>Send<[^>]*>/);
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(source).toContain("<MoltenWave />");
    });

    const Idle = { phase: "idle", reason: "", agentName: "", started: false, reply: "", where: null };
    const Where = { workspaceid: "ws-1", tabid: "tab-1", blockid: "block-1" };

    it("says what came of the last message under the field, in his words", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { ...Idle, phase: "busy", reason: "notready" });
        expect(render()).toMatch(
            /data-testid="brokk-talk-note" data-phase="busy"[^>]*><span>Brokk&#x27;s agent refused your message/
        );
        globalStore.set(stateAtom, { ...Idle, phase: "noagent" });
        expect(render()).toContain("No coding agent is installed to start Brokk");
    });

    // #2028: the developer sent a message and saw nothing; his answer was only in a hidden tab. #2033: it is in the window.
    it("keeps his answer out of the folded field: the line under the square carries it", () => {
        const session = BrokkSession.getInstance() as any;
        globalStore.set(session.stateAtom, { ...Idle, phase: "answered", reply: "Two agents run now.", where: Where });
        globalStore.set(session.exchangeAtom, [
            { id: "m1", role: "you", text: "how many agents run?", at: 1 },
            { id: "m1", role: "brokk", text: "Two agents run now.", actions: [], at: 2, turn: 3, final: true },
        ]);
        const html = render();
        expect(html).not.toContain("Two agents run now.");
        expect(html).not.toContain('data-testid="brokk-convo"');
        expect(html).not.toContain('data-testid="brokk-talk-note"');
    });

    it("tells the window is open in the field, once text is left in it", () => {
        expect(render()).toContain('data-open="false"');
        keepDraft("and the blocked ones?");
        const html = render();
        expect(html).toContain('data-open="true"');
        expect(html).toContain(">and the blocked ones?</textarea>");
    });

    // FR-BOSS-009 AC91 (#2285): open, the field is roomy, with the keys' hint and the send button under it; folded, it
    // keeps its one row with the button at its end.
    it("has a roomy field in the open window, with the hint and the send button under it", () => {
        const folded = render();
        expect(folded).not.toContain('data-testid="brokk-talk-foot"');
        expect(folded).toMatch(/data-testid="brokk-talk-input"[^>]*><\/textarea><button type="submit"/);
        keepDraft("hello");
        const html = render();
        expect(html).toMatch(
            /data-testid="brokk-talk-foot"><span class="mt-brokk-field-hint" data-testid="brokk-talk-hint">↵ to send · ⇧↵ for a new line<\/span><button type="submit"[^>]*data-testid="brokk-talk-send"/
        );
        expect(html.match(/data-testid="brokk-talk-send"/g)).toHaveLength(1);
        expect(html.indexOf('data-testid="brokk-talk-input"')).toBeLessThan(
            html.indexOf('data-testid="brokk-talk-foot"')
        );
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).toMatch(/\.mt-brokk-field\[data-open="true"\] \.mt-brokk-field-input \{[^}]*min-height: 52px;/);
    });

    it("opens as a log of the exchange named for him, with a hint while it is empty", () => {
        keepDraft("hello");
        const html = render();
        expect(html).toMatch(/data-testid="brokk-convo"[^>]*>/);
        expect(html).toContain('role="log"');
        expect(html).toContain('aria-label="Conversation with Brokk"');
        expect(html).toContain("Tell Brokk what you need.");
        expect(html.indexOf('data-testid="brokk-convo"')).toBeLessThan(html.indexOf('data-testid="brokk-talk-input"'));
    });

    it("shows the developer's messages and his answers in order, the field below them", () => {
        const session = BrokkSession.getInstance() as any;
        keepDraft("and?");
        globalStore.set(session.exchangeAtom, [
            { id: "m1", role: "you", text: "how many agents run?", at: 1 },
            { id: "m1", role: "brokk", text: "Two agents run now.", actions: [], at: 2, turn: 3, final: true },
            { id: "m2", role: "you", text: "who is blocked?", at: 3 },
            { id: "m2", role: "brokk", text: "Olivia.", actions: [], at: 4, turn: 4, final: true },
        ]);
        const html = render();
        // His answers are Markdown, in a paragraph (#2285).
        const order = [...html.matchAll(/data-testid="brokk-msg-text">(?:<p>)?([^<]*)</g)].map((m) => m[1]);
        expect(order).toEqual(["how many agents run?", "Two agents run now.", "who is blocked?", "Olivia."]);
        expect([...html.matchAll(/data-role="(you|brokk)"/g)].map((m) => m[1])).toEqual([
            "you",
            "brokk",
            "you",
            "brokk",
        ]);
        expect(html).not.toContain("Tell Brokk what you need.");
        expect(html.lastIndexOf("brokk-msg-text")).toBeLessThan(html.indexOf('data-testid="brokk-talk-input"'));
    });

    it("offers the replies of his last answer as buttons, and none once the developer answered", () => {
        const session = BrokkSession.getInstance() as any;
        keepDraft("hm");
        const answer = {
            id: "m1",
            role: "brokk",
            text: "Open the PR #2024?",
            actions: [
                { label: "Yes", authorise: false },
                { label: "No", authorise: false },
            ],
            at: 2,
            turn: 3,
            final: true,
        };
        globalStore.set(session.exchangeAtom, [{ id: "m1", role: "you", text: "any news?", at: 1 }, answer]);
        const html = render();
        expect(html.match(/data-testid="brokk-act"/g)).toHaveLength(2);
        expect(html).toMatch(/data-testid="brokk-act"[^>]*>Yes</);
        expect(html).toContain('aria-label="Replies Brokk offers"');
        globalStore.set(session.exchangeAtom, [
            { id: "m1", role: "you", text: "any news?", at: 1 },
            answer,
            { id: "m2", role: "you", text: "Yes", at: 3 },
        ]);
        expect(render()).not.toContain('data-testid="brokk-act"');
    });

    it("says he thinks inside the window, and not once his words are there", () => {
        const session = BrokkSession.getInstance() as any;
        keepDraft("hm");
        globalStore.set(session.stateAtom, { ...Idle, phase: "answering", where: Where });
        globalStore.set(session.exchangeAtom, [{ id: "m1", role: "you", text: "any news?", at: 1 }]);
        const html = render();
        expect(html).toMatch(
            /data-phase="answering"[^>]*><span><span data-testid="mock-domino"[^>]*><\/span>Brokk is thinking…/
        );
        expect(html.indexOf("brokk-talk-note")).toBeGreaterThan(html.indexOf('data-testid="brokk-convo"'));
        expect(html.indexOf("brokk-talk-note")).toBeLessThan(html.indexOf('data-testid="brokk-talk-input"'));

        globalStore.set(session.exchangeAtom, [
            { id: "m1", role: "you", text: "any news?", at: 1 },
            { id: "m1", role: "brokk", text: "Two", actions: [], at: 2, turn: 3, final: false },
        ]);
        expect(render()).not.toContain('data-testid="brokk-talk-note"');
    });

    it("says a failure inside the window, with its way out, and under the field when it is folded", () => {
        const session = BrokkSession.getInstance() as any;
        globalStore.set(session.stateAtom, { ...Idle, phase: "busy", reason: "notready" });
        const folded = render();
        expect(folded).toContain("mt-brokk-field-extra");
        expect(folded).toMatch(/data-testid="brokk-talk-wayout" data-way="retry"[^>]*>Try again</);
        keepDraft("are you there?");
        const open = render();
        expect(open).not.toContain("mt-brokk-field-extra");
        expect(open.indexOf('data-testid="brokk-talk-wayout"')).toBeGreaterThan(
            open.indexOf('data-testid="brokk-convo"')
        );
        expect(open).toMatch(/data-testid="brokk-talk-wayout" data-way="retry"[^>]*>Try again</);
    });

    it("says he settles in, then that he thinks, with the domino", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { ...Idle, phase: "starting" });
        expect(render()).toMatch(
            /data-phase="starting"[^>]*><span><span data-testid="mock-domino"[^>]*><\/span>Brokk is settling in…/
        );
        globalStore.set(stateAtom, { ...Idle, phase: "answering", where: Where });
        expect(render()).toMatch(
            /data-phase="answering"[^>]*><span><span data-testid="mock-domino"[^>]*><\/span>Brokk is thinking…/
        );
    });

    it("gives every failure a way out", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        const cases: [Record<string, unknown>, string, string][] = [
            [{ phase: "noagent" }, "chooseAgent", "Choose an agent"],
            [{ phase: "agentmissing" }, "chooseAgent", "Choose an agent"],
            [{ phase: "busy" }, "retry", "Try again"],
            [{ phase: "failed" }, "retry", "Try again"],
            [{ phase: "failed", reason: "noagent", where: Where }, "retry", "Try again"],
            [{ phase: "failed", reason: "humandraft", where: Where }, "clearAndSend", "Clear his prompt and send"],
            [{ phase: "failed", reason: "unknownprompt", where: Where }, "clearAndSend", "Clear his prompt and send"],
        ];
        for (const [state, way, label] of cases) {
            globalStore.set(stateAtom, { ...Idle, ...state });
            expect(render(), JSON.stringify(state)).toMatch(
                new RegExp(`data-testid="brokk-talk-wayout" data-way="${way}"[^>]*>${label}<`)
            );
        }
        globalStore.set(stateAtom, { ...Idle, phase: "unread", where: Where });
        expect(render()).toContain("Brokk answered in his terminal: open it to read him.");
    });

    // #2257: during a brainstorm his conversation stays open in his layer, beside his portrait, whatever has the focus.
    it("keeps his conversation open while the brainstorm is on", () => {
        keepDraft("");
        globalStore.set(BrainstormStateAtom, null);
        expect(render()).toContain('data-testid="brokk-talk" data-open="false"');
        globalStore.set(BrainstormStateAtom, { allowed: true, open: true, version: 1 });
        expect(render()).toContain('data-testid="brokk-talk" data-open="true"');
        globalStore.set(BrainstormStateAtom, { allowed: true, open: false, version: 2 });
        expect(render()).toContain('data-testid="brokk-talk" data-open="false"');
        globalStore.set(BrainstormStateAtom, null);
    });

    // #2284: a message waiting for him shows in his open conversation with its Cancel, and the field is free.
    it("shows the waiting message with its Cancel, the window open", () => {
        const session = BrokkSession.getInstance() as any;
        keepDraft("");
        globalStore.set(session.stateAtom, { ...Idle, phase: "queued", reason: "notready" });
        globalStore.set(session.queuedAtom, { text: "Look in my projects", since: 1 });
        try {
            const html = render();
            expect(html).toContain('data-testid="brokk-talk" data-open="true"');
            expect(html).toMatch(/data-testid="brokk-queued"[\s\S]*Look in my projects[\s\S]*Sent when Brokk is done/);
            expect(html).toContain('data-testid="brokk-queued-cancel"');
            expect(html).not.toContain('data-testid="brokk-talk-wayout"');
            expect(html).not.toContain("Try again");
        } finally {
            globalStore.set(session.queuedAtom, null);
        }
    });

    // #2284: after leaving a brainstorm, the way back is one line, where the brainstorm exists.
    it("offers to resume the brainstorm left, only where the brainstorm exists and outside it", () => {
        const last = {
            slug: "kids-video",
            title: "A safe video app",
            dir: "/synthetic",
            created: 1,
            updated: 2,
            turns: 2,
        };
        try {
            globalStore.set(BrainstormLastLeftAtom, last);
            gate.allowed = true;
            let html = render();
            expect(html).toContain('data-testid="brokk-talk-resume"');
            expect(html).toContain("Resume “A safe video app”");
            globalStore.set(BrainstormStateAtom, { allowed: true, open: true, version: 1 });
            expect(render()).not.toContain('data-testid="brokk-talk-resume"');
            globalStore.set(BrainstormStateAtom, null);
            gate.allowed = false;
            html = render();
            expect(html).not.toContain('data-testid="brokk-talk-resume"');
        } finally {
            gate.allowed = false;
            globalStore.set(BrainstormLastLeftAtom, null);
            globalStore.set(BrainstormStateAtom, null);
        }
    });

    // #2257: the field offers its one command while a slash starts, only where the brainstorm exists.
    it("offers /brainstorm while a slash starts, only where the brainstorm exists", () => {
        try {
            gate.allowed = true;
            keepDraft("/br");
            let html = render();
            expect(html).toContain('data-testid="brokk-talk-command"');
            expect(html).toContain("/brainstorm [idea]: brainstorm with Brokk");
            expect(html).toContain(
                'title="Enter to send, Shift+Enter for a new line, /brainstorm [idea] to brainstorm"'
            );
            keepDraft("hello");
            expect(render()).not.toContain("brokk-talk-command");
            gate.allowed = false;
            keepDraft("/br");
            html = render();
            expect(html).not.toContain("brokk-talk-command");
            expect(html).toContain('title="Enter to send, Shift+Enter for a new line"');
        } finally {
            gate.allowed = false;
            keepDraft("");
        }
    });

    // #2257: his agent's permission request shows in his talk window, in plain words with the exact command, and opens
    // his conversation; always allow only when his agent offers it; the note sending to his terminal gives way.
    it("shows his agent's permission request with its exact command and its answers", () => {
        const session = BrokkSession.getInstance() as any;
        const stateAtom = session.stateAtom;
        keepDraft("");
        globalStore.set(stateAtom, { ...Idle, phase: "needsanswer", where: Where });
        globalStore.set(session.permissionAtom, {
            id: "req-1",
            blockid: "block-1",
            tool: "Bash",
            kind: "command",
            subject: "npm test -- --run",
            at: 1,
        });
        try {
            const html = render();
            expect(html).toContain('data-testid="brokk-talk" data-open="true"');
            expect(html).toContain("Brokk&#x27;s agent asks to run this command:");
            expect(html).toMatch(/data-testid="brokk-permission-subject"[^>]*>npm test -- --run</);
            expect(html).toContain('data-testid="brokk-permission-allow"');
            expect(html).toContain('data-testid="brokk-permission-deny"');
            expect(html).not.toContain('data-testid="brokk-permission-always"');
            expect(html).not.toContain("his agent waits for you in his terminal");
            globalStore.set(session.permissionAtom, {
                id: "req-2",
                blockid: "block-1",
                tool: "Bash",
                kind: "command",
                subject: "npm test",
                always: true,
                at: 2,
            });
            expect(render()).toContain('data-testid="brokk-permission-always"');
            globalStore.set(session.permissionAtom, null);
            globalStore.set(session.approvedAtom, [{ id: "a1", kind: "command", subject: "npm run lint", at: 3 }]);
            globalStore.set(stateAtom, { ...Idle, phase: "answering", where: Where });
            keepDraft("x");
            expect(render()).toMatch(/Approved without asking: <code[^>]*>npm run lint</);
        } finally {
            globalStore.set(session.permissionAtom, null);
            globalStore.set(session.approvedAtom, []);
            globalStore.set(stateAtom, Idle);
            keepDraft("");
        }
    });

    // #2257: his terminal is never the main way out; it stays a secondary action beside the note.
    it("offers his terminal only beside the note, never as its way out", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        for (const state of [
            { phase: "unread", where: Where },
            { phase: "noreply", where: Where },
            { phase: "needsanswer", where: Where },
            { phase: "failed", reason: "noagent", where: Where },
            { phase: "failed", reason: "humandraft", where: Where },
        ]) {
            globalStore.set(stateAtom, { ...Idle, ...state });
            const html = render();
            expect(html, JSON.stringify(state)).not.toContain('data-way="openTerminal"');
            expect(html, JSON.stringify(state)).toMatch(/data-testid="brokk-talk-terminal"[^>]*>Open his terminal</);
        }
        globalStore.set(stateAtom, { ...Idle, phase: "failed", reason: "lookup", where: Where });
        expect(render()).not.toContain("brokk-talk-terminal");
    });

    it("waits with the domino while the message is on its way, and with no other spinner", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { ...Idle, phase: "sending" });
        const html = render();
        expect(html).toMatch(
            /data-testid="brokk-talk-note" data-phase="sending"[^>]*><span><span data-testid="mock-domino"/
        );
        expect(html).toContain("On its way…");
        expect(html).not.toContain("fa-spin");
        expect(html).not.toContain('data-testid="brokk-talk-wayout"');
    });

    it("gives its messages to his session, and keeps the text unless the agent has it", () => {
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        // The text as fieldAction reads it: trimmed, or the brainstorm's command where it exists (#2257).
        expect(source).toContain("const action = fieldAction(text, brainstormAllowed);");
        expect(source).toContain("await session.say(action.text, { clearPrompt })");
        // The idea goes now only when no brainstorm of nearly that title is saved (#2248).
        expect(source).toContain("const sendNow = await openBrainstorm(idea);");
        expect(source).toContain('if (idea === "" || !sendNow) {');
        // The field empties only when it still holds what was sent (review of #2257).
        expect(source).toContain("setText(fieldAfterSend(action.text, draft, result));");
        // A text starting with a slash stays in the field with its note.
        expect(source).toContain('if (action.kind === "slash") {');
        expect(source).toContain('onTyping(text.trim() !== "")');
    });
});
