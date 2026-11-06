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
vi.mock("./brokk-session", async () => {
    const { atom } = await import("jotai");
    const stateAtom = atom({ phase: "idle", reason: "", agentName: "", started: false });
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
        expect(html).toContain('placeholder="Talk to Brokk…"');
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

    it("says what came of the last message under the field, in his words", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { phase: "busy", reason: "notready", agentName: "", started: false });
        expect(render()).toMatch(/data-testid="brokk-talk-note" data-phase="busy"[^>]*>Brokk&#x27;s agent is busy/);
        globalStore.set(stateAtom, { phase: "noagent", reason: "", agentName: "", started: false });
        expect(render()).toContain("No coding agent is installed to start Brokk");
        globalStore.set(stateAtom, { phase: "sent", reason: "", agentName: "Claude Code", started: true });
        expect(render()).toContain("Claude Code started in Brokk&#x27;s own terminal.");
    });

    it("waits with the domino while the message is on its way, and with no other spinner", () => {
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { phase: "sending", reason: "", agentName: "", started: false });
        const html = render();
        expect(html).toMatch(/data-testid="brokk-talk-note" data-phase="sending"[^>]*><span data-testid="mock-domino"/);
        expect(html).toContain("On its way…");
        expect(html).not.toContain("fa-spin");
    });

    it("gives its messages to his session, and keeps the text unless the agent has it", () => {
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(source).toContain("await session.say(text.trim())");
        expect(source).toContain("if (!keepsText(result))");
        expect(source).toContain('onTyping(text.trim() !== "")');
    });
});
