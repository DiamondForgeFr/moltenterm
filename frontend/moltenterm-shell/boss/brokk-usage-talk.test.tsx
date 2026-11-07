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
vi.mock("../sessions/pane-focus", () => ({ showPane: vi.fn() }));
vi.mock("../settings/settings-open", () => ({ openSettingsSection: vi.fn() }));
vi.mock("./brokk-session", async () => {
    const { atom } = await import("jotai");
    const stateAtom = atom({ phase: "idle", reason: "", agentName: "", started: false, reply: "", where: null });
    return { BrokkSession: { getInstance: () => ({ stateAtom, say: vi.fn(), clearNote: vi.fn() }) } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { UsageReadingsAtom } from "./boss-usage";
import { BrokkSession } from "./brokk-session";
import { BrokkTalk } from "./brokk-talk";
import { BrokkUsageTab } from "./brokk-usage-tab";

const Now = Date.now();

beforeEach(() => {
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
        expect(render()).toMatch(/data-testid="brokk-talk-note" data-phase="busy"[^>]*><span>Brokk&#x27;s agent is busy/);
        globalStore.set(stateAtom, { ...Idle, phase: "noagent" });
        expect(render()).toContain("No coding agent is installed to start Brokk");
    });

    // #2028: the developer sent a message and saw nothing; his answer was only in a hidden tab.
    it("shows his answer under the field", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { ...Idle, phase: "answered", reply: "Two agents run now.", where: Where });
        const html = render();
        expect(html).toMatch(/data-testid="brokk-talk-reply" data-phase="answered" aria-label="Brokk&#x27;s answer"[^>]*>Two agents run now\.</);
        expect(html).not.toContain('data-testid="brokk-talk-note"');
    });

    it("says he settles in, then that he thinks, with the domino", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { ...Idle, phase: "starting" });
        expect(render()).toMatch(/data-phase="starting"[^>]*><span><span data-testid="mock-domino"[^>]*><\/span>Brokk is settling in…/);
        globalStore.set(stateAtom, { ...Idle, phase: "answering", where: Where });
        expect(render()).toMatch(/data-phase="answering"[^>]*><span><span data-testid="mock-domino"[^>]*><\/span>Brokk is thinking…/);
    });

    it("gives every failure a way out", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        const cases: [Record<string, unknown>, string, string][] = [
            [{ phase: "noagent" }, "chooseAgent", "Choose an agent"],
            [{ phase: "agentmissing" }, "chooseAgent", "Choose an agent"],
            [{ phase: "busy" }, "retry", "Try again"],
            [{ phase: "failed" }, "retry", "Try again"],
            [{ phase: "unread", where: Where }, "openTerminal", "Open his terminal"],
            [{ phase: "noreply", where: Where }, "openTerminal", "Open his terminal"],
            [{ phase: "failed", reason: "noagent", where: Where }, "openTerminal", "Open his terminal"],
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

    it("waits with the domino while the message is on its way, and with no other spinner", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { ...Idle, phase: "sending" });
        const html = render();
        expect(html).toMatch(/data-testid="brokk-talk-note" data-phase="sending"[^>]*><span><span data-testid="mock-domino"/);
        expect(html).toContain("On its way…");
        expect(html).not.toContain("fa-spin");
        expect(html).not.toContain('data-testid="brokk-talk-wayout"');
    });

    it("gives its messages to his session, and keeps the text unless the agent has it", () => {
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(source).toContain("await session.say(text.trim())");
        expect(source).toContain("if (!keepsText(result))");
        expect(source).toContain('onTyping(text.trim() !== "")');
    });
});
