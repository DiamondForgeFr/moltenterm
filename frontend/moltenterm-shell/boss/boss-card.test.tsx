// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "wsB" }) } };
});
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: { hasOpenModals: () => false } }));
vi.mock("../tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: () => ({}),
}));
vi.mock("../sessions/sessions-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom(null);
    return { DurableSessions: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const shownEntriesAtom = atom([]);
    return {
        MoltentermNotifications: { getInstance: () => ({ shownEntriesAtom, markRead: vi.fn(), archive: vi.fn() }) },
    };
});
vi.mock("./boss-card-actions", () => ({
    homeFolder: () => "/Users/me",
    locateSession: vi.fn(),
    goToLocation: vi.fn(),
    openSessionsView: vi.fn(),
    startTerminal: vi.fn(),
    openIntegrationPr: vi.fn(),
    rerunPrChecks: vi.fn(),
    openPrPage: vi.fn(),
    answerNotice: vi.fn(),
    answerHandoff: vi.fn(),
    openNotice: vi.fn(),
    markNoticeDone: vi.fn(),
}));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        nameAtom: atom("Brokk"),
        collapsedAtom: atom(false),
        badgeAtom: atom({ count: 0, text: "", tone: "waiting" }),
        workingCountAtom: atom(0),
        toHandleAtom: atom({ items: [], info: [], parked: 0 }),
        expand: vi.fn(),
        closeCard: vi.fn(),
        park: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
// His animated portrait has its own tests (brokk-live, use-brokk-live): here the card only asks for it.
vi.mock("./brokk-expressions", async () => {
    const { atom } = await import("jotai");
    const askedAtom = atom(null);
    return {
        BrokkExpressionsModel: { getInstance: () => ({ askedAtom, ask: vi.fn(), watch: vi.fn(() => () => {}) }) },
    };
});

import { globalStore } from "@/app/store/jotaiStore";
import { PendingHandoff } from "../agent-handoff-types";
import { DurableSession } from "../sessions/sessions-model";
import { DurableSessions } from "../sessions/sessions-store";
import { BossCard } from "./boss-card";
import { HandoffBriefView } from "./boss-handoff-row";
import { BossBubbleModel } from "./boss-store";
import { buildToHandle } from "./boss-to-handle-model";

const model = BossBubbleModel.getInstance() as any;
const sessionsAtom = DurableSessions.getInstance().dataAtom;

function session(id: string, extra: Partial<DurableSession> = {}): DurableSession {
    return {
        id,
        shortid: id.slice(0, 8),
        connection: "",
        connstate: "connected",
        workspaceorder: 0,
        shown: true,
        canshow: true,
        canend: true,
        workspaceid: "wsA",
        workspacename: "Alpha",
        startedat: Date.now() - 5 * 60 * 1000,
        ...extra,
    };
}

function load(...sessions: DurableSession[]) {
    globalStore.set(sessionsAtom, { sessions, runningagents: sessions.filter((s) => s.agent).length, version: 1 });
}

function render(): string {
    return renderToStaticMarkup(<BossCard style={{ right: "16px", bottom: "68px" }} />);
}

beforeEach(() => {
    globalStore.set(model.nameAtom, "Brokk");
    globalStore.set(model.collapsedAtom, false);
    globalStore.set(model.badgeAtom, { count: 0, text: "", tone: "waiting" });
    globalStore.set(model.toHandleAtom, { items: [], info: [], parked: 0 });
    globalStore.set(sessionsAtom, null);
});

function attr(html: string, testId: string, name: string): string {
    const tag = new RegExp(`<[a-z0-9]+ [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
    return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("the card's header (FR-BOSS-002, AC1)", () => {
    it("says it is the foreman's, with his name, in a non-modal dialog anchored by the style it is given", () => {
        const html = render();
        expect(attr(html, "boss-card", "role")).toBe("dialog");
        expect(attr(html, "boss-card", "aria-modal")).toBe("false");
        expect(attr(html, "boss-card", "aria-label")).toBe("Brokk&#x27;s card: to handle, sessions and notifications");
        expect(attr(html, "boss-card", "style")).toBe("right:16px;bottom:68px");
        expect(html).toMatch(/data-testid="boss-card-title"[^>]*>Brokk&#x27;s card</);
        globalStore.set(model.nameAtom, "Léa");
        expect(render()).toMatch(/data-testid="boss-card-title"[^>]*>Léa&#x27;s card</);
    });

    it("can take the focus once it opens, and is no part of the tab order", () => {
        expect(attr(render(), "boss-card", "tabindex")).toBe("-1");
    });

    it("shows the badge count in its header, in the badge's tone, hidden at zero", () => {
        expect(render()).not.toContain('data-testid="boss-card-count"');
        globalStore.set(model.badgeAtom, { count: 3, text: "3", tone: "waiting" });
        let html = render();
        expect(attr(html, "boss-card-count", "data-tone")).toBe("waiting");
        expect(html).toMatch(/data-testid="boss-card-count"[^>]*>3 waiting</);
        globalStore.set(model.badgeAtom, { count: 12, text: "9+", tone: "error" });
        html = render();
        expect(attr(html, "boss-card-count", "data-tone")).toBe("error");
        expect(html).toMatch(/data-testid="boss-card-count"[^>]*>12 waiting</);
    });

    it("has a visible close control with a name", () => {
        const html = render();
        expect(html).toContain('data-testid="boss-card-close"');
        expect(attr(html, "boss-card-close", "aria-label")).toBe("Close");
        expect(attr(html, "boss-card-close", "type")).toBe("button");
    });

    it("offers Show the bubble only while the foreman is folded into his pennant (AC6)", () => {
        expect(render()).not.toContain('data-testid="boss-card-show-bubble"');
        globalStore.set(model.collapsedAtom, true);
        expect(render()).toMatch(/data-testid="boss-card-show-bubble"[^>]*>Show the bubble</);
    });
});

describe("the sessions (AC2, AC3)", () => {
    beforeEach(() =>
        load(
            session("a1", {
                agent: "claude",
                agentname: "Claude Code",
                agentstate: "waiting",
                firstname: "Léa",
                workspaceid: "wsA",
                workspacename: "Alpha",
                workspaceorder: 1,
                worktree: { path: "/Users/me/forge", branch: "feature/12-card", main: "/Users/me/forge" },
            }),
            session("b1", {
                agent: "codex",
                agentname: "Codex",
                agentstate: "working",
                firstname: "Max",
                workspaceid: "wsB",
                workspacename: "Beta",
                workspaceorder: 2,
                connection: "dev@box",
                folder: "/srv/api",
            }),
            session("p1", {
                shown: false,
                workspaceid: "wsB",
                workspacename: "Beta",
                workspaceorder: 2,
                command: "npm run dev",
            })
        )
    );

    it("lists every workspace's sessions in groups, the ones without a pane first, the current workspace marked", () => {
        const html = render();
        const groups = [...html.matchAll(/data-testid="boss-card-group" data-group="([^"]*)"/g)].map((m) => m[1]);
        expect(groups).toEqual(["hidden", "wsA", "wsB"]);
        expect(html).toContain("Not in a pane");
        expect(html).toContain("Alpha");
        expect(html).toContain("Beta");
        const beta = html.slice(html.indexOf('data-group="wsB"'));
        expect(beta).toContain("This workspace");
        expect(html.slice(html.indexOf('data-group="wsA"'), html.indexOf('data-group="wsB"'))).not.toContain(
            "This workspace"
        );
    });

    it("tells each agent's first name, state, project, branch and how long it has run", () => {
        const html = render();
        const row = html.slice(html.indexOf('data-session="a1"'), html.indexOf('data-session="b1"'));
        expect(row).toMatch(/data-testid="boss-card-name"[^>]*>Léa</);
        expect(row).toMatch(/data-testid="boss-card-state"[^>]*>waiting for you</);
        expect(row).toMatch(/data-testid="boss-card-project"[^>]*>forge</);
        expect(row).toContain("feature/12-card");
        expect(row).toMatch(/data-testid="boss-card-up"[^>]*>up 5 min</);
    });

    it("names the host of a session that runs elsewhere", () => {
        const html = render();
        const row = html.slice(html.indexOf('data-session="b1"'));
        expect(row).toMatch(/data-testid="boss-card-host"[^>]*>[\s\S]*dev@box/);
        expect(html.slice(html.indexOf('data-session="a1"'), html.indexOf('data-session="b1"'))).not.toContain(
            'data-testid="boss-card-host"'
        );
    });

    it("offers Go to for a session in a pane and Show it for one whose pane is gone, each named for its row", () => {
        const html = render();
        const goTo = html.slice(html.indexOf('data-session="a1"'), html.indexOf('data-session="b1"'));
        expect(goTo).toMatch(/aria-label="Go to Léa"[^>]*data-testid="boss-card-go"[^>]*>Go to</);
        const showIt = html.slice(html.indexOf('data-session="p1"'));
        expect(showIt).toMatch(/aria-label="Show [^"]* in a pane"[^>]*data-testid="boss-card-go"[^>]*>Show it</);
        expect(html.match(/data-testid="boss-card-go"/g)).toHaveLength(3);
    });

    it("disables Go to for a session that cannot be shown, and says why", () => {
        load(
            session("old", { shown: false, canshow: false, reason: "olderversion", firstname: "Zoé", agent: "claude" })
        );
        const html = render();
        expect(html).toMatch(
            /title="Started by an older MoltenTerm: it can only be ended\."[^>]*>|<button[^>]*disabled=""/
        );
        expect(html).toContain('disabled=""');
        expect(html).toContain("Started by an older MoltenTerm: it can only be ended.");
    });

    it("has no bulk action of its own: bulk actions stay in the Sessions view", () => {
        const html = render();
        expect(html).not.toContain('type="checkbox"');
        expect(html).not.toContain("End session");
    });
});

describe("the full view (AC4)", () => {
    it("offers Open the Sessions view, whatever the list holds", () => {
        expect(render()).toMatch(/data-testid="boss-card-open-sessions"[^>]*>[\s\S]*Open the Sessions view</);
        load(session("a1"));
        expect(render()).toContain('data-testid="boss-card-open-sessions"');
    });
});

describe("with nothing running (AC7)", () => {
    it("says so in one line and offers New terminal", () => {
        load();
        const html = render();
        expect(html).toContain('data-testid="boss-card-empty"');
        expect(html).toContain("No session is running.");
        expect(html).toMatch(/data-testid="boss-card-new-terminal"[^>]*>New terminal</);
        expect(html).not.toContain('data-testid="boss-card-group"');
    });

    it("offers it only then", () => {
        load(session("a1"));
        expect(render()).not.toContain('data-testid="boss-card-new-terminal"');
    });

    it("wears the Molten call to action: its class, and the wave as its last child", () => {
        load();
        const html = render();
        const button = html.slice(html.indexOf('data-testid="boss-card-new-terminal"'));
        expect(button).toMatch(/^[^>]*>[^<]*New terminal[\s\S]*?<\/button>/);
        expect(html).toMatch(/class="molten-btn [^"]*"[^>]*data-testid="boss-card-new-terminal"/);
    });
});

describe("while the first list is on its way", () => {
    it("waits with the dominoes and says what for", () => {
        const html = render();
        expect(html).toContain('data-testid="boss-card-loading"');
        expect(html).toContain("Loading sessions…");
        expect(html).not.toContain('data-testid="boss-card-empty"');
    });
});

describe("the card is a layer, not a panel (AC9)", () => {
    it("holds no native dialog, no scrim, and no form control that would keep the focus", () => {
        load(session("a1", { agent: "claude", firstname: "Léa" }));
        const html = render();
        expect(html).not.toContain("<dialog");
        expect(html).not.toContain("molten-scrim");
        expect(html).not.toContain("<input");
        expect(html).not.toContain("<select");
        expect(html).not.toContain("<textarea");
    });

    it("is positioned absolutely over the content and takes no room", () => {
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        const rule = /\.mt-boss-card \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(rule).toContain("position: absolute;");
        expect(rule).toContain("overflow: hidden;");
        expect(rule).not.toMatch(/\b(position:\s*(static|relative|sticky))\b/);
    });
});

describe("the card's tabs (FR-BOSS-003, AC1, AC2, AC7)", () => {
    it("shows the three tabs in order, each with its count, as a tablist", () => {
        load(session("a1", { agent: "claude", firstname: "Léa" }));
        const html = render();
        expect(html).toContain('role="tablist"');
        expect(html.indexOf('data-testid="boss-card-tab-todo"')).toBeLessThan(
            html.indexOf('data-testid="boss-card-tab-sessions"')
        );
        expect(html.indexOf('data-testid="boss-card-tab-sessions"')).toBeLessThan(
            html.indexOf('data-testid="boss-card-tab-notifications"')
        );
        expect(html).toMatch(/data-testid="boss-card-tab-count-todo"[^>]*>0</);
        expect(html).toMatch(/data-testid="boss-card-tab-count-sessions"[^>]*>1</);
    });

    it("opens on the Sessions tab when the badge counts nothing", () => {
        const html = render();
        expect(attr(html, "boss-card-tab-sessions", "aria-selected")).toBe("true");
        expect(attr(html, "boss-card-tab-todo", "aria-selected")).toBe("false");
    });

    it("opens on To handle when the badge counts something, and shows the row's actions", () => {
        globalStore.set(model.badgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(model.toHandleAtom, {
            items: [
                {
                    key: "agent:b1",
                    tone: "waiting",
                    notice: null,
                    lineFromNotice: false,
                    name: "Léa",
                    line: { key: "boss.todo.agentWaiting", vars: { name: "Léa" } },
                    place: "Alpha",
                    since: 0,
                    rank: 1,
                    seen: false,
                    actions: [
                        {
                            id: "goto",
                            primary: true,
                            labelKey: "boss.todo.goTo",
                            labelVars: { name: "Léa" },
                            disabled: false,
                            run: { kind: "goto", sessionId: "s1" },
                        },
                        {
                            id: "later",
                            primary: false,
                            labelKey: "boss.todo.later",
                            disabled: false,
                            run: { kind: "later" },
                        },
                    ],
                },
            ],
            info: [],
            parked: 0,
        });
        const html = render();
        expect(attr(html, "boss-card-tab-todo", "aria-selected")).toBe("true");
        expect(html).toContain('data-testid="boss-card-todo-row"');
        expect(html).toContain("Léa waits for you");
        expect(html).toContain("Go to Léa");
        expect(html).toContain("Later");
        expect(html).toMatch(/data-act="goto"[^>]*data-primary="true"/);
    });

    it("says so in one line when nothing waits, and lists the info rows apart", () => {
        globalStore.set(model.badgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(model.toHandleAtom, {
            items: [],
            info: [{ key: "done:b9", name: "Tristan", place: "Alpha", line: { key: "boss.todo.infoDone" } }],
            parked: 2,
        });
        const html = render();
        expect(html).toContain('data-testid="boss-card-todo-empty"');
        expect(html).toContain("Nothing waits for you.");
        expect(html).toContain("For info, nothing to do");
        expect(html).toContain('data-testid="boss-card-info-row"');
        expect(html).toContain("2 set aside");
    });

    it("draws a typed prompt's row with Done, and once seen marks it and leaves it out of the tab's count (#1938)", () => {
        const typed = (read: boolean) =>
            ({
                id: "t1",
                key: "agenthandofftyped:b2",
                source: "agents",
                kind: "warning",
                title: "Typed in Chloé's prompt: press Enter in its terminal to start",
                time: Date.now() - 1000,
                updated: Date.now() - 1000,
                read,
                blockid: "b2",
                actions: [{ id: "goto", label: "Go to Chloé", kind: "open", blockid: "b2" }],
            }) as any;
        const list = (read: boolean) =>
            buildToHandle({
                states: { states: {}, versions: {} },
                notifications: [typed(read)],
                answers: {},
                readied: {},
                sessions: [],
                parked: {},
            });
        globalStore.set(model.badgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(model.toHandleAtom, list(false));
        let html = render();
        expect(html).toMatch(/data-act="done"[^>]*>Done</);
        expect(html).toContain('data-seen="false"');
        expect(html).not.toContain('data-testid="boss-card-todo-seen"');
        expect(html).toMatch(/data-testid="boss-card-tab-count-todo"[^>]*>1</);
        globalStore.set(model.toHandleAtom, list(true));
        html = render();
        expect(html).toContain('data-seen="true"');
        expect(html).toContain('data-testid="boss-card-todo-seen"');
        expect(html).toMatch(/data-act="done"/);
        expect(html).not.toMatch(/data-testid="boss-card-tab-count-todo"[^>]*>1</);
    });
});

function handoff(requestid: string, extra: Partial<PendingHandoff> = {}): PendingHandoff {
    return {
        requestid,
        fromblockid: "bs",
        toblockid: "br",
        from: "Chloé",
        to: "Léa",
        goal: "Propose characters for MoltenTerm",
        createdat: Date.now() - 60 * 1000,
        fromworkspace: "DiamondForge",
        toworkspace: "MoltenTerm",
        brief: {
            goal: "Propose characters for MoltenTerm,\nin the style of <b>Geargrim</b>",
            context: "Read the notes first.",
            files: [
                { path: "/work/df/characters.md" },
                { path: "/work/df/geargrim/README.md", lines: "4-9", note: "the style" },
            ],
            links: [{ url: "https://example.test/ticket/7", title: "Ticket 7", kind: "ticket" }],
            reply: true,
        },
        ...extra,
    };
}

function showHandoffs(...requests: PendingHandoff[]) {
    const list = buildToHandle({
        states: { states: {}, versions: {} } as any,
        notifications: [],
        answers: {},
        readied: {},
        sessions: [],
        parked: {},
        handoffs: requests,
    });
    globalStore.set(model.badgeAtom, { count: list.items.length, text: String(list.items.length), tone: "waiting" });
    globalStore.set(model.toHandleAtom, list);
    return list;
}

describe("the hand-off rows (FR-BOSS-005)", () => {
    it("lists a request under its group: who asks whom, from where, the goal and what is attached", () => {
        showHandoffs(handoff("r1"));
        const html = render();
        expect(html).toContain('data-testid="boss-card-todo-handoffs"');
        expect(html).toContain("Handoffs between agents");
        expect(html).toMatch(/data-testid="boss-card-handoff-from"[^>]*>Chloé</);
        expect(html).toMatch(/data-testid="boss-card-handoff-to"[^>]*>Léa</);
        expect(html).toContain("DiamondForge");
        expect(html).toContain("MoltenTerm");
        expect(html).toMatch(/data-testid="boss-card-handoff-goal"[^>]*>“Propose characters for MoltenTerm”</);
        expect(html).toMatch(
            /data-testid="boss-card-handoff-attached"[^>]*>Attached: characters\.md, README\.md, Ticket 7</
        );
        expect(attr(html, "boss-card-todo-row", "data-handoff")).toBe("r1");
        expect(html).toMatch(/data-testid="boss-card-tab-count-todo"[^>]*>1</);
    });

    it("says what the receiver will find, and that nothing else from the sender reaches it", () => {
        showHandoffs(handoff("r1"));
        expect(render()).toMatch(
            /data-testid="boss-card-handoff-sees"[^>]*>Léa will find the brief in its terminal, with 2 files and 1 link\. Nothing else from the sender reaches it\./
        );
        showHandoffs(handoff("r2", { brief: { goal: "Check the build" } }));
        expect(render()).toMatch(
            /data-testid="boss-card-handoff-sees"[^>]*>Léa will find the brief in its terminal, with no file or link\./
        );
    });

    it("offers Allow once as the one primary action, then Always for this pair, Refuse and Read the brief", () => {
        showHandoffs(handoff("r1"));
        const html = render();
        const acts = [
            ...html.matchAll(/data-act="([a-z]+)"[^>]*data-kind="([a-z]+)"[^>]*data-primary="(true|false)"/g),
        ];
        expect(acts.map((a) => [a[1], a[2], a[3]])).toEqual([
            ["once", "handoff", "true"],
            ["always", "handoff", "false"],
            ["refuse", "handoff", "false"],
            ["brief", "brief", "false"],
        ]);
        expect(html).toContain("Allow once");
        expect(html).toContain("Always for this pair");
        expect(html).toContain("Refuse");
        expect(html).toContain("Read the brief");
        expect(html).not.toContain("Hide the brief");
        expect(html).not.toContain("Later");
    });

    it("keeps the brief closed until the developer reads it", () => {
        showHandoffs(handoff("r1"));
        const html = render();
        expect(html).not.toContain('data-testid="boss-card-handoff-brief"');
        expect(html).toContain('aria-expanded="false"');
    });

    it("names an unnamed terminal in words, and a request without a workspace by its project", () => {
        showHandoffs(handoff("r1", { from: "", fromworkspace: "", fromproject: "forge" }));
        const html = render();
        expect(html).toMatch(/data-testid="boss-card-handoff-from"[^>]*>A terminal</);
        expect(html).toContain("forge");
    });

    it("sets the group apart from the other rows, which keep their own heading only beside it", () => {
        showHandoffs(handoff("r1"));
        expect(render()).not.toContain("Everything else");
        expect(render()).not.toContain('data-testid="boss-card-todo-list"');
        const list = buildToHandle({
            states: {
                states: { b1: { blockid: "b1", workspaceid: "w1", agent: "claude", state: "waiting", version: 1 } },
                versions: {},
            } as any,
            notifications: [],
            answers: {},
            readied: {},
            sessions: [],
            parked: {},
            handoffs: [handoff("r1")],
        });
        globalStore.set(model.toHandleAtom, list);
        const html = render();
        expect(html).toContain("Everything else");
        expect(html.indexOf('data-testid="boss-card-todo-handoffs"')).toBeLessThan(
            html.indexOf('data-testid="boss-card-todo-list"')
        );
        expect(html).toMatch(/data-testid="boss-card-tab-count-todo"[^>]*>2</);
    });

    it("shows the whole brief as text when it is read: goal, context, files with their lines, links, reply", () => {
        const item = showHandoffs(handoff("r1")).items[0];
        const html = renderToStaticMarkup(<HandoffBriefView item={item} from="Chloé" to="Léa" />);
        expect(html).toContain("in the style of &lt;b&gt;Geargrim&lt;/b&gt;");
        expect(html).not.toContain("<b>Geargrim</b>");
        expect(html).toContain("Read the notes first.");
        expect(html).toContain("/work/df/geargrim/README.md");
        expect(html).toContain("lines 4-9");
        expect(html).toContain("the style");
        expect(html).toContain("https://example.test/ticket/7");
        expect(html).toContain("Léa is asked to reply to Chloé.");
        const quiet = showHandoffs(handoff("r2", { brief: { goal: "Check the build" } })).items[0];
        expect(renderToStaticMarkup(<HandoffBriefView item={quiet} from="Chloé" to="Léa" />)).toContain(
            "No reply is expected."
        );
    });
});
