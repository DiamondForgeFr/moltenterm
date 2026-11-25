// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
// The settings of the usage detail's choices (#2341): one atom a key, so a test sets what the settings hold.
vi.mock("@/app/store/global", async (importOriginal) => {
    const { atom } = await import("jotai");
    const settings = new Map<string, ReturnType<typeof atom>>();
    return {
        ...(await importOriginal<typeof import("@/app/store/global")>()),
        getSettingsKeyAtom: (key: string) => {
            if (!settings.has(key)) {
                settings.set(key, atom(undefined as unknown));
            }
            return settings.get(key);
        },
    };
});
vi.mock("../command-panel/bindings", () => ({ writeSettings: vi.fn(async () => {}) }));
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

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { BrainstormLastLeftAtom, BrainstormStateAtom } from "../brainstorm/brainstorm-boot";
import { UsageReadingsAtom, UsageUnreadableAtom, UsageUseAtom } from "./boss-usage";
import { answerPermission, BrokkPermissions } from "./brokk-permission";
import { BrokkSession } from "./brokk-session";
import { BrokkTalk, keepDraft } from "./brokk-talk";
import { BrokkUsageTab } from "./brokk-usage-tab";

const Now = Date.now();

beforeEach(() => {
    keepDraft("");
    globalStore.set((BrokkSession.getInstance() as any).exchangeAtom, []);
    globalStore.set(UsageReadingsAtom, {});
    globalStore.set(UsageUnreadableAtom, {});
    globalStore.set(UsageUseAtom, null);
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

    // #2532: the grid draws a month like a week, the detail of the windows is as it was (FR-BOSS-009 AC111).
    it("lists a month and a session as one bar each, with no week control, no week deduced from the month", () => {
        const day = 24 * 60 * 60 * 1000;
        globalStore.set(UsageReadingsAtom, {
            kimi: {
                agent: "kimi",
                source: "t",
                readat: Now,
                windows: [
                    {
                        id: "session",
                        label: "Current session",
                        usedpercent: 15,
                        resetsat: Now + 3600000,
                        windowmins: 300,
                    },
                    { id: "month", label: "This month", usedpercent: 30, resetsat: Now + 20 * day, sessionworth: 1.5 },
                ],
            },
        });
        const html = renderToStaticMarkup(<BrokkUsageTab />);
        expect(html.match(/data-testid="brokk-usage-row"/g)).toHaveLength(2);
        expect(html).toContain(">This month<");
        expect(html).toContain(">30 %<");
        expect(html).toContain("width:30%");
        expect(html).not.toContain("usage-week");
        expect(html).not.toContain("Week (from the month)");
    });

    // #2341: FR-BOSS-009, AC93 and AC97.
    describe("the order of use and the providers not used lately", () => {
        const Day = 24 * 60 * 60 * 1000;
        const claude = {
            agent: "claude",
            source: "t",
            readat: Now,
            windows: [{ id: "w", label: "7d", usedpercent: 96 }],
        };
        const codex = {
            agent: "codex",
            source: "t",
            readat: Now,
            windows: [{ id: "w", label: "7d", usedpercent: 20 }],
        };
        const old = {
            agent: "old",
            source: "t",
            plan: "free",
            readat: Now - 10 * Day,
            windows: [{ id: "w", label: "30-day", usedpercent: 100, resetsat: Now + 20 * Day, windowmins: 43200 }],
        };
        const used = (minutes: number) => ({ workms: minutes * 60_000, sessions: 1, lastat: Now - Day });
        const providers = (html: string) => [...html.matchAll(/data-provider="([^"]+)"/g)].map((m) => m[1]);

        it("lists the providers in the order the grid uses, the most used first", () => {
            globalStore.set(UsageReadingsAtom, { claude, codex });
            globalStore.set(UsageUseAtom, { claude: used(5), codex: used(50) });
            expect(providers(renderToStaticMarkup(<BrokkUsageTab />))).toEqual(["codex", "claude"]);
        });

        it("lists a free plan nobody used under Not used lately, with its last reading, and not among the providers", () => {
            globalStore.set(UsageReadingsAtom, { claude, old });
            globalStore.set(UsageUseAtom, { claude: used(5) });
            const html = renderToStaticMarkup(<BrokkUsageTab />);
            const list = html.slice(0, html.indexOf('data-testid="brokk-usage-not-used"'));
            expect(providers(list)).toEqual(["claude"]);
            const hidden = html.slice(html.indexOf('data-testid="brokk-usage-not-used"'));
            expect(hidden).toContain("Not used lately");
            expect(providers(hidden)).toEqual(["old"]);
            expect(hidden).toContain("Last use 10 d ago");
            expect(hidden).toContain(">free<");
            expect(hidden).toContain("Always show");
        });

        // AC97: the choices are buttons, so the keyboard reaches them as the pointer does.
        it("offers each hidden provider Always show, and Show automatically to one the developer hid", () => {
            const hide = getSettingsKeyAtom("boss:usagehide") as unknown as PrimitiveAtom<string[]>;
            globalStore.set(hide, ["claude"]);
            try {
                globalStore.set(UsageReadingsAtom, { claude, old });
                globalStore.set(UsageUseAtom, {});
                const html = renderToStaticMarkup(<BrokkUsageTab />);
                const items = html.split('data-testid="brokk-usage-hidden-item"').slice(1);
                expect(items).toHaveLength(2);
                const [chosen, unused] = items;
                expect(chosen).toContain('data-provider="claude"');
                expect(chosen).toContain("Hidden by you");
                expect(chosen).toContain('aria-label="Always show: Agent claude"');
                expect(chosen).toContain('aria-label="Show automatically: Agent claude"');
                expect(chosen.match(/<button type="button"/g)).toHaveLength(2);
                expect(unused).toContain('data-provider="old"');
                expect(unused).toContain('aria-label="Always show: Agent old"');
                expect(unused).not.toContain("Show automatically");
                expect(unused.match(/<button type="button"/g)).toHaveLength(1);
            } finally {
                globalStore.set(hide, undefined);
            }
        });

        it("says no use was seen for a provider that was neither read nor used", () => {
            globalStore.set(UsageReadingsAtom, {});
            globalStore.set(UsageUnreadableAtom, { codex: "signedout" });
            globalStore.set(UsageUseAtom, {});
            const html = renderToStaticMarkup(<BrokkUsageTab />);
            expect(html).toContain("No use seen");
            expect(html).toContain('data-reason="unused"');
        });
    });
});

describe("the field to talk to him (FR-BOSS-009, AC9 and AC15)", () => {
    function render(): string {
        return renderToStaticMarkup(<BrokkTalk onTyping={() => {}} />);
    }

    // The cards of his agent's requests and questions, as the window draws them once they loaded.
    function renderCards(picks: Record<string, string[]> = {}, onPicks = () => {}): string {
        return renderToStaticMarkup(
            <BrokkPermissions
                name="Brokk"
                onAnswer={() => {}}
                picks={picks}
                answering={false}
                onPicks={onPicks}
                onSendPicks={() => {}}
            />
        );
    }

    it("is named for him, with a Send that waits for a message", () => {
        const html = render();
        expect(html).toContain('data-testid="brokk-talk-input"');
        // AC102 (#2382): the placeholder says what to write; no empty area says it any more.
        expect(html).toContain('placeholder="Tell Brokk what you need…"');
        expect(html).toContain('aria-label="Message to Brokk"');
        expect(html).toMatch(
            /data-testid="brokk-talk-send"[^>]*><i class="[^"]*fa-paper-plane[^"]*" aria-hidden="true"><\/i>Send</
        );
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
        expect(render()).toMatch(
            /class="molten-btn mt-brokk-send [^"]*"[^>]*><i [^>]*><\/i>Send<i class="molten-btn-wave"/
        );
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(source).toContain("<MoltenWave />");
    });

    // #2303: with nothing to send, the molten fill at half opacity read as a flat brown pill. It is calm instead, and the
    // pointer never turns into the not-allowed one.
    it("has a calm Send while there is nothing to send, never a dimmed orange", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        const calm = /\.mt-brokk-field \.molten-btn\.mt-brokk-send:disabled \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(calm).toContain("opacity: 1;");
        expect(calm).toContain("background-color: var(--mt-surface-2);");
        expect(calm).toContain("color: var(--mt-text-3);");
        expect(calm).toContain("box-shadow: inset 0 0 0 1px var(--mt-line-2);");
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(source).not.toContain("cursor-not-allowed");
        expect(css).not.toContain("not-allowed");
        keepDraft("hello");
        expect(render()).toMatch(
            /<button type="submit" data-testid="brokk-talk-send"[^>]* class="molten-btn mt-brokk-send /
        );
    });

    // #2303: the field shows its focus. Folded, the one-row frame takes the action line and an ember ring; open, the inset
    // well holding the field and its footer does, and the frame keeps its calm line.
    it("shows the focus on the folded frame and on the open window's well", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).toMatch(
            /\.mt-brokk-field\[data-open="false"\]:focus-within \{[^}]*border-color: color-mix\(in srgb, var\(--mt-action\) 60%, transparent\);[^}]*box-shadow: 0 0 0 3px var\(--mt-action-wash\);/
        );
        expect(css).toMatch(
            /\.mt-brokk-field\[data-open="true"\] \.mt-brokk-composer:focus-within \{[^}]*inset 0 0 0 1px color-mix\(in srgb, var\(--mt-action\) 60%, transparent\),\s*0 0 0 3px var\(--mt-action-wash\);/
        );
        expect(css).not.toMatch(/\.mt-brokk-field\[data-open="true"\] \{[^}]*border-color/);
        expect(css).toMatch(
            /\.mt-brokk-field\[data-open="true"\] \.mt-brokk-composer \{[^}]*background: var\(--mt-surface-0\);/
        );
    });

    // #2303: the well is in the tree folded too, laid out as if it were not, so that opening the window (on the field's
    // focus) never remounts the field and never takes its focus away.
    it("keeps the field at the same place in the tree, folded and open", () => {
        const at = /data-testid="brokk-talk-composer"><div class="mt-brokk-field-row"><textarea/;
        const folded = render();
        expect(folded).toMatch(at);
        expect(folded).not.toContain('data-testid="brokk-talk-foot"');
        keepDraft("hello");
        const open = render();
        expect(open).toMatch(at);
        expect(open).toMatch(/<\/textarea><\/div><div class="mt-brokk-field-foot" data-testid="brokk-talk-foot">/);
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).toMatch(/\.mt-brokk-composer \{\s*display: contents;\s*\}/);
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

    // FR-BOSS-009 AC103 (#2382): open, the composer of today's chat apps: a compact field from one line, and one small
    // row of controls under it with Send at its end, no hint line; folded, it keeps its one row with the button at its
    // end.
    it("is a compact composer in the open window, with Send at the end of its row of controls", () => {
        const folded = render();
        expect(folded).not.toContain('data-testid="brokk-talk-foot"');
        expect(folded).toMatch(/data-testid="brokk-talk-input"[^>]*><\/textarea><button type="submit"/);
        keepDraft("hello");
        const html = render();
        expect(html).toMatch(
            /data-testid="brokk-talk-foot"><span class="mt-brokk-field-hint" data-testid="brokk-talk-hint"><\/span><button type="submit"[^>]*data-testid="brokk-talk-send"[^>]*aria-label="Send" title="Send"/
        );
        expect(html).not.toContain("↵ to send");
        expect(html.match(/data-testid="brokk-talk-send"/g)).toHaveLength(1);
        expect(html.indexOf('data-testid="brokk-talk-input"')).toBeLessThan(
            html.indexOf('data-testid="brokk-talk-foot"')
        );
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).toMatch(/\.mt-brokk-field\[data-open="true"\] \.mt-brokk-field-input \{[^}]*min-height: 32px;/);
        expect(css).toMatch(/\.mt-brokk-field\[data-open="true"\] \.mt-brokk-composer \{[^}]*margin: 8px;/);
        expect(css).toMatch(/\.mt-brokk-field-foot \{[^}]*height: 32px;/);
        // The window is as tall as what it holds: the talk measures the exchange and the composer (AC102, AC104).
        const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(source).toContain("onContentHeight?.(convo + composer.offsetHeight + ComposerMarginPx);");
    });

    // AC102 (#2382): the large empty area that said "Tell Brokk what you need." is gone: nothing said, the window is the
    // composer alone. Once something is said, the exchange stacks above it, as a log named for him (AC104).
    it("is only the composer while nothing has been said, then a log of the exchange above it", () => {
        keepDraft("hello");
        const empty = render();
        expect(empty).toContain('data-open="true"');
        expect(empty).not.toContain('data-testid="brokk-convo"');
        expect(empty).not.toContain("Tell Brokk what you need.");
        const session = BrokkSession.getInstance() as any;
        globalStore.set(session.exchangeAtom, [{ id: "m1", role: "you", text: "how many agents run?", at: 1 }]);
        const html = render();
        expect(html).toMatch(/data-testid="brokk-talk" data-open="true" data-convo="true"/);
        expect(html).toContain('role="log"');
        expect(html).toContain('aria-label="Conversation with Brokk"');
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
            expect(html).toContain('aria-label="Resume the last brainstorm, “A safe video app”"');
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

    // #2303: on the gold the way back floated over the terminal with no surface, on three centred lines, and did not read
    // as clickable; open, it read as a label. It is the resume card in both windows: an opaque plate, the title on one
    // line, the molten Resume and a quiet × for Not now.
    it("offers the way back as the resume card, folded under the field and in the open window", () => {
        const last = {
            slug: "allotment-ledger",
            title: "A pocket ledger for allotment gardeners who share tools",
            dir: "/synthetic",
            created: 1,
            updated: 2,
            turns: 2,
        };
        try {
            globalStore.set(BrainstormLastLeftAtom, last);
            gate.allowed = true;
            const folded = render();
            const hang = folded.slice(folded.indexOf('class="mt-brokk-field-extra"'));
            expect(hang).toMatch(
                /^class="mt-brokk-field-extra"><div role="group"[^>]*class="mt-brokk-resume" data-testid="brokk-talk-resume"/
            );
            expect(hang).toContain(">Last brainstorm<");
            expect(hang).toContain(
                'class="mt-brokk-resume-title" title="A pocket ledger for allotment gardeners who share tools"'
            );
            expect(hang).toMatch(
                /class="molten-btn mt-brokk-resume-go [^"]*" data-testid="brokk-talk-resume-go">Resume<i class="molten-btn-wave"/
            );
            expect(hang).toMatch(/aria-label="Not now" title="Not now" data-testid="brokk-talk-resume-dismiss"/);
            keepDraft("hello");
            const open = render();
            const convo = open.slice(
                open.indexOf('data-testid="brokk-convo"'),
                open.indexOf('data-testid="brokk-talk-composer"')
            );
            expect(convo).toContain('data-testid="brokk-talk-resume"');
            expect(open).not.toContain('class="mt-brokk-field-extra"');
            expect(open.match(/data-testid="brokk-talk-resume"/g)).toHaveLength(1);
        } finally {
            gate.allowed = false;
            globalStore.set(BrainstormLastLeftAtom, null);
        }
    });

    // #2303: whatever hangs under the folded field stands on its own opaque plate, never as bare text over the terminal.
    it("puts what hangs under the folded field on opaque plates", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        const plate = /\.mt-brokk-field-extra > :not\(\.mt-brokk-resume\) \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(plate).toContain("background: var(--mt-surface-1);");
        expect(plate).toContain("border: 1px solid var(--mt-line-2);");
        expect(plate).toContain("box-shadow: var(--mt-shadow-e2);");
        const stateAtom = (BrokkSession.getInstance() as any).stateAtom;
        globalStore.set(stateAtom, { ...Idle, phase: "busy", reason: "notready" });
        const html = render();
        expect(html).toMatch(/class="mt-brokk-field-extra"><div role="status" data-testid="brokk-talk-note"/);
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
            // The window opens for it, and the card loads in it (outside the JavaScript loaded up front).
            const html = render();
            expect(html).toContain('data-testid="brokk-talk" data-open="true" data-convo="true"');
            expect(html).not.toContain("his agent waits for you in his terminal");
            expect(html).not.toContain('data-testid="brokk-talk-terminal"');
            const card = renderCards();
            expect(card).toContain("Brokk&#x27;s agent asks to run this command:");
            expect(card).toMatch(/data-testid="brokk-permission-subject"[^>]*>npm test -- --run</);
            expect(card).toContain('data-testid="brokk-permission-allow"');
            expect(card).toContain('data-testid="brokk-permission-deny"');
            expect(card).not.toContain('data-testid="brokk-permission-always"');
            globalStore.set(session.permissionAtom, {
                id: "req-2",
                blockid: "block-1",
                tool: "Bash",
                kind: "command",
                subject: "npm test",
                always: true,
                at: 2,
            });
            expect(renderCards()).toContain('data-testid="brokk-permission-always"');
            // #2382 (AC101): the searches a question about the projects leads to are read too.
            globalStore.set(session.permissionAtom, {
                id: "req-3",
                blockid: "block-1",
                tool: "Glob",
                kind: "find",
                subject: "/w/projects/**/.manifest.json",
                at: 3,
            });
            expect(renderCards()).toContain("Brokk&#x27;s agent asks to look for these files:");
            globalStore.set(session.permissionAtom, null);
            globalStore.set(session.approvedAtom, [{ id: "a1", kind: "command", subject: "npm run lint", at: 3 }]);
            globalStore.set(stateAtom, { ...Idle, phase: "answering", where: Where });
            keepDraft("x");
            expect(renderCards()).toMatch(/Approved without asking: <code[^>]*>npm run lint</);
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

    // #2349: answering an authorisation in his window keeps the developer in it. The clicked button is disabled, then
    // leaves with its card: the focus it held would drop on the page, and the window, open while its field has the
    // focus, would fold. The focus goes to his field before the answer goes, whatever the answer and whatever his agent.
    describe("an answer given in his window keeps it open (#2349)", () => {
        const Ask = { id: "req-9", blockid: "block-1", tool: "Bash", kind: "command", subject: "npm test", at: 1 };

        for (const decision of ["allow", "always", "deny"] as const) {
            it(`hands the focus to his field before the ${decision} goes`, async () => {
                const session = BrokkSession.getInstance() as any;
                const steps: string[] = [];
                let finish: (status: string) => void;
                session.permit.mockImplementationOnce((ask: any, d: string) => {
                    steps.push(`permit ${ask.id} ${d}`);
                    return new Promise((resolve) => (finish = resolve));
                });
                const answered = answerPermission(Ask as any, decision, () => steps.push("focus field"));
                expect(steps).toEqual(["focus field", `permit req-9 ${decision}`]);
                finish("answered");
                await expect(answered).resolves.toBe("answered");
                expect(steps).toEqual(["focus field", `permit req-9 ${decision}`]);
            });
        }

        it("gives the card the window's own way to keep its focus", () => {
            const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
            expect(source).toContain(
                "const keepConversation = () => inputRef.current?.focus({ preventScroll: true });"
            );
            expect(source).toMatch(/<BrokkPermissions\s+name=\{name\}\s+onAnswer=\{keepConversation\}/);
            const card = readFileSync(join(__dirname, "brokk-permission.tsx"), "utf8");
            expect(card).toContain("await answerPermission(ask, decision, onAnswer);");
            expect(card).toContain("<BrokkPermissionCard ask={ask} name={name} onAnswer={onAnswer} />");
        });

        // A reply that authorises turns into Confirm and Cancel, so the button clicked leaves too; Confirm goes even
        // while an earlier message is on its way, and the window still keeps the developer.
        it("keeps the focus in the window through a reply, its confirmation and its cancel", () => {
            const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
            for (const handler of [
                "const pick = (action: InlineAction) => {",
                "const confirm = () => {",
                "const cancel = () => {",
                "const sendReply = async (reply: string) => {",
            ]) {
                expect(source, handler).toContain(`${handler}\n        keepConversation();`);
            }
        });

        it("scrolls to what follows once the card is gone", () => {
            const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
            expect(source).toContain("}, [open, convoShown, items, state.phase, confirming, text, ask, queued]);");
        });
    });

    // #2382 (AC100): his agent's question is answered in the window: its choices are buttons, any other answer is
    // written in the composer, whose placeholder says so; no note sends the developer to his terminal.
    describe("his agent's question, answered in place (AC100)", () => {
        const Question = {
            id: "q-1",
            blockid: "block-1",
            tool: "AskUserQuestion",
            kind: "question",
            subject: "Where are the projects?",
            at: 1,
            questions: [
                {
                    question: "Where are the projects?",
                    header: "Folder",
                    options: [
                        { label: "Documents", description: "the usual place" },
                        { label: "Elsewhere", description: "another folder" },
                    ],
                },
            ],
        };

        it("shows the question with its choices, and lets the composer answer it", () => {
            const session = BrokkSession.getInstance() as any;
            globalStore.set(session.stateAtom, { ...Idle, phase: "needsanswer", where: Where });
            globalStore.set(session.permissionAtom, Question);
            try {
                const html = render();
                expect(html).toContain('data-convo="true"');
                expect(html).toContain('placeholder="Answer Brokk…"');
                expect(html).toContain(">Your answer goes to his question<");
                expect(html).not.toContain("his agent waits for you in his terminal");
                const card = renderCards();
                expect(card).toContain('data-testid="brokk-question"');
                expect(card).toContain("Brokk&#x27;s agent asks you:");
                expect(card).toContain(">Where are the projects?</p>");
                expect(
                    [
                        ...card.matchAll(
                            /data-testid="brokk-question-choice"[^>]*><span class="mt-brokk-choice-label">([^<]*)</g
                        ),
                    ].map((m) => m[1])
                ).toEqual(["Documents", "Elsewhere"]);
                expect(card).toContain(">the usual place<");
                expect(card).toContain("Or write your own answer below.");
                // One question, one choice: a click answers it, with no Send of its own.
                expect(card).not.toContain('data-testid="brokk-question-send"');
                expect(card).not.toContain('data-testid="brokk-permission-allow"');
                const picked = renderCards({ "Where are the projects?": ["Documents"] });
                expect(picked).toMatch(
                    /aria-pressed="true"[^>]*class="mt-brokk-choice cursor-pointer mt-selected-action"/
                );
                const written = renderCards({ "Where are the projects?": ["In the work folder"] });
                expect(written).toContain(">Your answer: In the work folder<");
            } finally {
                globalStore.set(session.permissionAtom, null);
                globalStore.set(session.stateAtom, Idle);
            }
        });

        it("waits for Send when a question takes several choices, or several questions are asked", () => {
            const session = BrokkSession.getInstance() as any;
            globalStore.set(session.permissionAtom, {
                ...Question,
                questions: [{ ...Question.questions[0], multiselect: true }],
            });
            try {
                expect(renderCards()).toMatch(/data-testid="brokk-question-send"[^>]*>Send the answers</);
                expect(renderCards()).toMatch(
                    /<button type="button" disabled=""[^>]*data-testid="brokk-question-send"/
                );
            } finally {
                globalStore.set(session.permissionAtom, null);
            }
        });

        it("answers the open question with the composer's text, not as a new message", () => {
            const source = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
            expect(source).toContain("if (openAsk != null && !clearPrompt) {");
            expect(source).toContain("await answerQuestion({ ...questionPicks, [openAsk.question]: [typed] });");
            expect(source).toContain("await session.answer(question, answers);");
        });
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
