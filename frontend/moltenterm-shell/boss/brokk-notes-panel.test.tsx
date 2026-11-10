// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { workspace: atom({ oid: "wsA", name: "Alpha" }) },
        getApi: () => ({ switchWorkspace: vi.fn(), openNativePath: vi.fn() }),
    };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const entriesAtom = atom([] as any[]);
    const model = {
        entriesAtom,
        shownEntriesAtom: entriesAtom,
        unreadCountAtom: atom(0),
        runningAtom: atom({}),
        errorsAtom: atom({}),
        settleSeen: vi.fn(),
        markAllRead: vi.fn(),
        clearArchive: vi.fn(),
        clear: vi.fn(() => async () => {}),
        open: vi.fn(),
        runAction: vi.fn(),
    };
    return { MoltentermNotifications: { getInstance: () => model } };
});
vi.mock("../running-work", () => ({
    canStop: () => true,
    stopWork: vi.fn(),
    useRunningWork: () => (globalThis as any).__work ?? [],
}));
// The work that runs and the failing-row boundary are the centre's own (notification-center.tsx), tested there.
vi.mock("../notification-center", () => ({
    RowBoundary: ({ children }: { children: unknown }) => children,
    WorkRow: ({ item }: { item: { title: string } }) => <div data-testid="running-work">{item.title}</div>,
}));
vi.mock("../notification-settings", () => ({ openNotificationSettings: vi.fn() }));
vi.mock("../sidebar/sidebar-undo", () => ({ showUndoToast: vi.fn() }));
vi.mock("../project/project-tab", () => ({ showProjectTab: vi.fn() }));

import { globalStore } from "@/app/store/jotaiStore";
import { MoltentermNotifications } from "../notifications-store";
import { ToHandleItem, ToHandleList } from "./boss-to-handle-model";
import { buildNotes, NoteRow } from "./brokk-notes-model";
import { NotificationsPanel } from "./brokk-notes-panel";
import { DefaultVisitSettings } from "./brokk-visit-events";
import type { BrokkActions } from "./use-brokk-actions";

const model = MoltentermNotifications.getInstance() as any;
const Min = 60_000;
const Now = Date.now();

function entry(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        time: Now - 60_000,
        updated: Now - 60_000,
        kind: "info",
        read: false,
        source: "agents",
        title: `Title ${id}`,
        message: `Message ${id}`,
        ...over,
    };
}

function todo(key: string, over: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone: "waiting",
        notice: null,
        lineFromNotice: false,
        name: key.split(":")[1] ?? key,
        line: { text: `${key} waits` },
        place: "",
        since: Now - 2 * Min,
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
            { id: "later", primary: false, labelKey: "boss.todo.later", disabled: false, run: { kind: "later" } },
            { id: "ignore", primary: false, labelKey: "boss.todo.ignore", disabled: false, run: { kind: "ignore" } },
        ],
        ...over,
    };
}

const Actions: BrokkActions = {
    busyId: null,
    problem: "",
    goToSession: vi.fn(),
    runTodo: vi.fn(),
    reconnect: vi.fn(),
    archive: vi.fn(() => async () => {}),
};

function workspaces(): Map<string, Workspace> {
    return new Map<string, Workspace>([
        ["wsA", { oid: "wsA", name: "Alpha", color: "#ff7c0d", meta: {} } as any],
        ["wsB", { oid: "wsB", name: "Beta", color: "#4cc38a", meta: {} } as any],
    ]);
}

function rowsOf(list: Partial<ToHandleList> = {}, entries = globalStore.get(model.entriesAtom) as any[]): NoteRow[] {
    return buildNotes({
        toHandle: { items: [], info: [], parked: 0, ...list },
        entries,
        settings: DefaultVisitSettings,
        now: Now,
    });
}

function render(rows: NoteRow[] = rowsOf(), highlight: string[] = [], parked = 0): string {
    return renderToStaticMarkup(
        <NotificationsPanel
            rows={rows}
            parked={parked}
            now={Now}
            workspaces={workspaces()}
            highlightIds={highlight}
            actions={Actions}
            onLeave={() => {}}
            onClose={() => {}}
            onListed={() => {}}
        />
    );
}

function tags(html: string, testId: string): string[] {
    return [...html.matchAll(new RegExp(`<[a-z0-9]+ [^>]*data-testid="${testId}"[^>]*>`, "g"))].map((m) => m[0]);
}

beforeEach(() => {
    globalStore.set(model.entriesAtom, []);
    globalStore.set(model.unreadCountAtom, 0);
    (globalThis as any).__work = [];
});

describe("the Notifications panel is the notification centre, with À traiter in it (FR-BOSS-009, AC19; FR-MC-019)", () => {
    it("says so in one line when nothing waits", () => {
        const html = render();
        expect(html).toContain('data-testid="notification-empty"');
        expect(html).toContain("Nothing needs your attention.");
    });

    it("lists the notifications, each with its Archive and silence actions", () => {
        globalStore.set(model.entriesAtom, [entry("n1", { source: "ci" }), entry("n2", { source: "build" })]);
        const html = render();
        expect(html.match(/data-testid="notification-row"/g)).toHaveLength(2);
        expect(html).toContain('data-notif="n1"');
        expect(html.match(/data-testid="notification-archive"/g)).toHaveLength(2);
        expect(html).toContain('aria-label="Archive"');
        // An info notification of a subject can be silenced: "Don't tell me again…".
        expect(html).toContain('data-testid="notification-silence"');
    });

    it("makes each active notification focusable, for Delete and Backspace (#2026)", () => {
        globalStore.set(model.entriesAtom, [entry("n1")]);
        expect(tags(render(), "notification-row")[0]).toContain('tabindex="0"');
    });

    it("carries a notification's own actions as buttons", () => {
        globalStore.set(model.entriesAtom, [
            entry("n1", {
                actions: [
                    { id: "a", label: "Open the log", kind: "gesture", gesture: "x" },
                    { id: "b", label: "Copy it", kind: "gesture", gesture: "y" },
                ],
            }),
        ]);
        const html = render();
        expect(html.match(/data-testid="notification-action"/g)).toHaveLength(2);
        expect(html).toContain(">Open the log<");
        expect(html).toContain(">Copy it<");
    });

    it("marks the notifications the panel was asked to show", () => {
        globalStore.set(model.entriesAtom, [entry("n1"), entry("n2")]);
        const rows = tags(render(rowsOf(), ["n2"]), "notification-row");
        expect(rows).toHaveLength(2);
        expect(rows.filter((r) => r.includes('data-highlighted="true"'))).toHaveLength(1);
        expect(rows.find((r) => r.includes('data-highlighted="true"'))).toContain('data-notif="n2"');
    });

    it("shows the work that runs on top", () => {
        (globalThis as any).__work = [{ id: "run1", kind: "build", dir: "/p", title: "Build the app", progress: 0.4 }];
        const html = render();
        expect(html).toContain("Running");
        expect(html.indexOf('data-testid="running-work"')).toBeLessThan(
            html.indexOf('data-testid="notification-center"') + 4000
        );
        expect(html).toContain("Build the app");
    });

    it("keeps the rows To handle: an agent that waits, with its Go to, Later and Archive", () => {
        const html = render(rowsOf({ items: [todo("agent:b1")] }));
        expect(tags(html, "boss-card-todo-row")).toHaveLength(1);
        expect(html).toContain('data-todo="agent:b1"');
        expect(tags(html, "boss-card-todo-action").map((t) => /data-act="([^"]*)"/.exec(t)[1])).toEqual(["goto"]);
        expect(html).toContain('data-testid="boss-card-todo-later"');
        // Ignorer and the × are one Archive (#2195).
        expect(html).not.toContain('data-testid="boss-card-todo-ignore"');
        expect(html).toContain('data-testid="notification-archive"');
    });

    it("draws a row the developer has already seen as seen, and dimmed", () => {
        const html = render(rowsOf({ items: [todo("notif:n1", { seen: true })] }));
        expect(html).toContain('data-seen="true"');
        expect(html).toContain('data-testid="boss-card-todo-seen"');
        expect(html).toContain(">Seen<");
        expect(render(rowsOf({ items: [todo("notif:n2")] }))).not.toContain('data-testid="boss-card-todo-seen"');
    });

    it("keeps the count of the rows set aside with Later, and the agents that finished as Fait rows", () => {
        const html = render(
            rowsOf({
                items: [],
                info: [{ key: "done:b9", name: "Benoît", place: "Alpha", line: { key: "boss.todo.infoDone" } }],
            }),
            [],
            2
        );
        expect(html).toContain('data-testid="boss-card-todo-parked"');
        expect(html).toContain('data-testid="boss-card-info-row"');
        expect(html).toContain("Benoît");
    });
});

describe("the header keeps what the centre offered, as compact icon buttons (FR-MC-019)", () => {
    it("offers Mark all read while something is unread, and the link to the settings always", () => {
        expect(render()).not.toContain('data-testid="notification-mark-all-read"');
        expect(render()).toContain('data-testid="notification-settings-link"');
        globalStore.set(model.entriesAtom, [entry("n1")]);
        globalStore.set(model.unreadCountAtom, 1);
        expect(render()).toContain('data-testid="notification-mark-all-read"');
    });

    it("gives each header button a tooltip and an accessible name, and no text link", () => {
        globalStore.set(model.entriesAtom, [entry("n1")]);
        globalStore.set(model.unreadCountAtom, 1);
        const html = render();
        for (const id of ["notification-mark-all-read", "notification-archive-all", "notification-settings-link"]) {
            const tag = tags(html, id)[0];
            expect(tag, id).toMatch(/aria-label="[^"]+"/);
            expect(tag, id).toMatch(/title="[^"]+"/);
        }
        expect(tags(html, "notification-archive-all")[0]).toContain('aria-label="Archive all"');
        expect(html).toContain('title="Archives every card of the list. You can undo it for a few seconds."');
    });

    it("offers Archive all while the list has a card of any kind, and not on an empty one (#2195)", () => {
        expect(render()).not.toContain('data-testid="notification-archive-all"');
        globalStore.set(model.entriesAtom, [entry("n1")]);
        expect(render()).toContain('data-testid="notification-archive-all"');
        globalStore.set(model.entriesAtom, []);
        expect(render(rowsOf({ items: [todo("agent:b1")] }))).toContain('data-testid="notification-archive-all"');
        expect(
            render(
                rowsOf({ info: [{ key: "done:b9", name: "Benoît", place: "", line: { key: "boss.todo.infoDone" } }] })
            )
        ).toContain('data-testid="notification-archive-all"');
    });

    it("archives every card of the list with an undo toast, never a confirmation (#2195)", () => {
        const source = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(source).toContain("const undo = actions.archive(archivePlan(cards, entries));");
        expect(source).toContain('showUndoToast(translateCount("notif.center.archivedCount", cards.length), undo)');
        expect(source).toContain("onClick={() => archiveCards(rows)}");
        expect(source).toContain("onArchive={() => archiveCards([row])}");
        expect(source).not.toContain("window.confirm");
    });

    it("keeps the Archived list, with its switch beside the title, once something was archived", () => {
        globalStore.set(model.entriesAtom, [entry("n1"), entry("n2", { archived: Date.now() })]);
        const html = render();
        expect(html).toContain('data-testid="notification-list-archived"');
        expect(tags(html, "notification-list-archived")[0]).toContain('aria-pressed="false"');
        expect(html.match(/data-testid="notification-row"/g)).toHaveLength(1);
        const source = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(source).toContain('testId="notification-clear-archive"');
        expect(source).toContain("onClick={() => model.clearArchive()}");
        // No archive, no switch.
        globalStore.set(model.entriesAtom, [entry("n1")]);
        expect(render()).not.toContain('data-testid="notification-list-archived"');
    });

    it("counts the rows it lists next to its title", () => {
        globalStore.set(model.entriesAtom, [entry("n1"), entry("n2")]);
        expect(render()).toMatch(/data-testid="brokk-panel-count-notifications"[^>]*>2</);
    });
});

describe("one list, sorted by priority, then date (FR-BOSS-009, AC19)", () => {
    it("lists Urgent, then À répondre, then Info, then Fait", () => {
        globalStore.set(model.entriesAtom, [entry("info"), entry("done", { kind: "success" })]);
        const html = render(
            rowsOf({
                items: [
                    todo("ready:/p:3", { tone: "success", since: Now - Min }),
                    todo("agent:fresh", { since: Now - Min }),
                    todo("agent:late", { since: Now - 20 * Min }),
                ],
            })
        );
        const order = [
            ...html.matchAll(/data-priority="(urgent|answer|info|done)"[^>]*data-(?:todo|notif|info)="([^"]+)"/g),
        ].map((m) => `${m[1]}:${m[2]}`);
        expect(order).toEqual(["urgent:agent:late", "answer:agent:fresh", "info:info", "done:done", "done:ready:/p:3"]);
    });

    it("tells each row's priority by a word, not by colour alone", () => {
        globalStore.set(model.entriesAtom, [entry("info")]);
        const html = render(rowsOf({ items: [todo("agent:a")] }));
        expect(html).toContain(">To answer<");
        expect(html).toContain(">Info<");
    });

    it("gives the orange button to Urgent and À répondre rows only, and to one button per row", () => {
        globalStore.set(model.entriesAtom, [
            entry("info", { actions: [{ id: "a", label: "Open the log", kind: "gesture", gesture: "x" }] }),
        ]);
        const html = render(
            rowsOf({
                items: [
                    todo("agent:late", { since: Now - 20 * Min }),
                    todo("agent:fresh", { since: Now - Min }),
                    todo("ci:/p:2", {
                        tone: "error",
                        name: "#2",
                        actions: [{ ...todo("x").actions[0], id: "failure" }],
                    }),
                    todo("ready:/p:3", {
                        tone: "success",
                        name: "#3",
                        actions: [{ ...todo("x").actions[0], id: "integration" }],
                    }),
                ],
            })
        );
        const primaries = [...html.matchAll(/<button [^>]*data-primary="true"[^>]*>/g)];
        // The two waiting agents have one orange Go to each; nothing else has one.
        expect(primaries).toHaveLength(2);
        for (const m of primaries) {
            expect(m[0]).toMatch(/data-act="goto"/);
        }
        const calm = [...html.matchAll(/<button [^>]*data-primary="false"[^>]*>/g)];
        expect(calm.length).toBeGreaterThanOrEqual(3);
        // The wave of an orange button is drawn once per orange button.
        expect(html.match(/molten-btn-wave/g)?.length ?? 0).toBe(primaries.length);
    });

    it("puts Archive last on a notification's row, after its actions", () => {
        globalStore.set(model.entriesAtom, [
            entry("n1", { actions: [{ id: "a", label: "Open the log", kind: "gesture", gesture: "x" }] }),
        ]);
        const html = render();
        expect(html.indexOf('data-testid="notification-action"')).toBeLessThan(
            html.indexOf('data-testid="notification-archive"')
        );
    });

    it("puts the date on the first line with the priority and the workspace", () => {
        globalStore.set(model.entriesAtom, [entry("n1", { workspaceid: "wsB" })]);
        const html = render();
        const header = /<div class="mt-brokk-rh">(.*?)<\/div>/.exec(html)?.[1] ?? "";
        expect(header).toContain("mt-brokk-pri");
        expect(header).toContain('data-testid="workspace-chip"');
        expect(header).toContain("mt-brokk-when");
    });
});

describe("the workspace on each row (FR-BOSS-009, AC19)", () => {
    it("names the workspace of a notification, of an agent and of a pull request, with a coloured dot", () => {
        globalStore.set(model.entriesAtom, [entry("n1", { workspaceid: "wsB" })]);
        const html = render(
            rowsOf({
                items: [todo("agent:a", { workspaceid: "wsA" }), todo("ci:/proj:5", { tone: "error", dir: "/proj" })],
            })
        );
        const names = [...html.matchAll(/data-testid="workspace-name">([^<]*)</g)].map((m) => m[1]);
        expect(names.sort()).toEqual(["Alpha", "Beta"]);
        expect(html).toContain("background:#4cc38a");
        expect(html).toContain("background:#ff7c0d");
    });

    it("leads to the workspace from its name", () => {
        globalStore.set(model.entriesAtom, [entry("n1", { workspaceid: "wsB" })]);
        const tag = tags(render(), "workspace-chip")[0];
        expect(tag).toContain('aria-label="Go to workspace Beta"');
    });

    it("finds the workspace of a pull request from its project folder", () => {
        const source = readFileSync(join(__dirname, "brokk-workspace-tag.tsx"), "utf8");
        expect(source).toContain("readWorkspaceProject(workspace).dir");
        expect(readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8")).toContain("labelOfRow(");
    });
});

describe("Info notifications leave once consulted (FR-BOSS-009, AC19)", () => {
    it("reports the notifications it lists, so that the group can settle the Info ones when it closes", () => {
        const source = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(source).toContain('onListed(listedKey === "" ? [] : listedKey.split(","))');
        const group = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(group).toContain("consultedIds(rowsRef.current, listedRef.current)");
        expect(group).toContain("notifications.handle(ids)");
        expect(group).toContain("notifications.settleSeen()");
    });
});

describe("the source of a notification, shown once (FR-BOSS-009, AC19)", () => {
    const withWorkspaces = () =>
        renderToStaticMarkup(
            <NotificationsPanel
                rows={rowsOf()}
                parked={0}
                now={Now}
                workspaces={
                    new Map<string, Workspace>([
                        ["wsM", { oid: "wsM", name: "MoltenTerm", color: "#ff7c0d", meta: {} } as any],
                        ["wsA", { oid: "wsA", name: "Alpha", color: "#4cc38a", meta: {} } as any],
                    ])
                }
                highlightIds={[]}
                actions={Actions}
                onLeave={() => {}}
                onClose={() => {}}
                onListed={() => {}}
            />
        );

    it("does not say MoltenTerm twice on the app's own update in the MoltenTerm workspace", () => {
        globalStore.set(model.entriesAtom, [
            entry("u1", { source: "moltenterm", workspaceid: "wsM", title: "Update" }),
        ]);
        const html = withWorkspaces();
        expect(html).not.toContain('data-testid="notification-source"');
        expect(html.match(/>MoltenTerm</g)).toHaveLength(1);
        expect(html).toContain('data-testid="workspace-name">MoltenTerm<');
    });

    it("keeps the source when it is not the workspace's name", () => {
        globalStore.set(model.entriesAtom, [
            entry("c1", { source: "ci", workspaceid: "wsA" }),
            entry("u2", { source: "moltenterm", workspaceid: "wsA" }),
        ]);
        const html = withWorkspaces();
        expect(tags(html, "notification-source")).toHaveLength(2);
        expect(html).toMatch(/data-testid="notification-source">CI</);
        expect(html).toMatch(/data-testid="notification-source">MoltenTerm</);
    });
});

// One card of every kind the panel lists: a notification (Info, Fait, with its own action, with a place it comes from),
// the rows To handle (an agent, a failing CI, a pull request ready, a hand-off request) and an agent that finished.
function everyKind(): NoteRow[] {
    globalStore.set(model.entriesAtom, [
        entry("info", { source: "ci" }),
        entry("acts", {
            source: "build",
            actions: [{ id: "a", label: "Open the log", kind: "gesture", gesture: "x" }],
        }),
        entry("done", { kind: "success", source: "agent", workspaceid: "wsA", blockid: "b7", title: "Léa is done" }),
        entry("lead", { source: "agent", workspaceid: "wsA", blockid: "b8", title: "Marc has a lead" }),
    ]);
    return rowsOf({
        items: [
            todo("agent:b1"),
            todo("ci:/p:2", { tone: "error", name: "#2", actions: [{ ...todo("x").actions[0], id: "failure" }] }),
            todo("ready:/p:3", {
                tone: "success",
                name: "#3",
                actions: [{ ...todo("x").actions[0], id: "integration" }],
            }),
            todo("handoff:r1", {
                name: "Léa",
                actions: [
                    {
                        id: "once",
                        primary: true,
                        labelKey: "boss.todo.handoff.once",
                        disabled: false,
                        run: { kind: "handoff", requestid: "r1", decision: "once" },
                    },
                    {
                        id: "brief",
                        primary: false,
                        labelKey: "boss.todo.handoff.brief",
                        disabled: false,
                        run: { kind: "brief" },
                    },
                ],
                handoff: {
                    requestid: "r1",
                    from: "Léa",
                    to: "Marc",
                    fromPlace: "",
                    toPlace: "",
                    goal: "Review the plan",
                    files: [],
                    links: [],
                    brief: { goal: "Review the plan" },
                },
            }),
        ],
        info: [
            {
                key: "done:b9",
                name: "Bérénice",
                place: "Alpha",
                workspaceid: "wsA",
                blockid: "b9",
                sessionid: "s9",
                since: Now - 5 * Min,
                line: { key: "boss.todo.infoDone" },
            },
        ],
    });
}

function cardsOf(html: string): string[] {
    return html.split("<li ").slice(1);
}

describe("every card can be archived, and all of them at once (#2195, FR-MC-019 AC15 and AC16)", () => {
    it("ends the action line of every kind of card with one Archive", () => {
        const cards = cardsOf(render(everyKind()));
        expect(cards).toHaveLength(9);
        for (const card of cards) {
            expect(card.match(/data-testid="notification-archive"/g), card.slice(0, 160)).toHaveLength(1);
        }
    });

    it("shows Archive on hover and on keyboard focus, never behind a menu", () => {
        const html = render(everyKind());
        const button = tags(html, "notification-archive")[0];
        expect(button).toContain("group-hover:opacity-100");
        expect(button).toContain("group-focus-within:opacity-100");
        expect(button).toContain("focus-visible:opacity-100");
        expect(button).toContain('aria-label="Archive"');
        expect(html).not.toContain('aria-haspopup="menu"');
    });

    it("makes every active card focusable, for Delete and Backspace", () => {
        for (const card of cardsOf(render(everyKind()))) {
            expect(card.slice(0, card.indexOf(">"))).toContain('tabindex="0"');
        }
    });

    it("offers no Archive in the archived list", () => {
        globalStore.set(model.entriesAtom, [entry("old", { archived: Date.now() }), entry("n1")]);
        const source = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(source).toContain("const archiveButton = archived ? null : <ArchiveButton");
        expect(source).toContain("archive={archived ? null : <ArchiveButton onArchive={onArchive} />}");
    });

    it("has no separate × on the first line, nor an Ignorer, any more", () => {
        const html = render(everyKind());
        expect(html).not.toContain('data-testid="notification-clear"');
        expect(html).not.toContain('data-testid="boss-card-todo-ignore"');
        for (const card of cardsOf(html)) {
            const header = /<div class="mt-brokk-rh">(.*?)<\/div>/.exec(card)?.[1] ?? "";
            expect(header).not.toContain("notification-archive");
        }
    });
});

describe("one anatomy for every kind of card (#2195, FR-MC-019 AC20)", () => {
    it("gives each card a first line, one title line and one action line", () => {
        const cards = cardsOf(render(everyKind()));
        for (const card of cards) {
            expect(card, card.slice(0, 160)).toContain('class="mt-brokk-rh"');
            expect(card).toContain('data-testid="brokk-note-priority"');
            expect(card.match(/class="mt-brokk-rt[ "]/g), card.slice(0, 160)).toHaveLength(1);
            expect(card.match(/data-testid="brokk-card-actions"/g), card.slice(0, 160)).toHaveLength(1);
            expect(card.indexOf("mt-brokk-rh")).toBeLessThan(card.indexOf("mt-brokk-rt"));
            expect(card.indexOf("mt-brokk-rt")).toBeLessThan(card.indexOf('data-testid="brokk-card-actions"'));
        }
    });

    it("writes every title line in the same weight, with no bold for an unread card", () => {
        const html = render(everyKind());
        for (const card of cardsOf(html)) {
            const title = /<div class="mt-brokk-rt[^"]*"/.exec(card)?.[0] ?? "";
            expect(title).not.toMatch(/font-(semibold|bold|normal)/);
        }
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(/\.mt-brokk-rt \{[^}]*font-weight: 500;/.test(css)).toBe(true);
    });

    it("says the agent's name or the event, then its short text, on the title line", () => {
        const html = render(everyKind());
        const finished = tags(html, "boss-card-info-name")[0];
        expect(finished).toBeDefined();
        expect(html).toMatch(
            /data-testid="boss-card-info-name"[^>]*><span class="line-clamp-3 min-w-0">Bérénice<span class="text-muted"[^>]*> · <\/span><span class="text-secondary">Finished its work\.<\/span>/
        );
        expect(html).toMatch(
            /data-testid="notification-title"[^>]*><span class="line-clamp-3 min-w-0">Title info<span class="text-muted"[^>]*> · <\/span><span class="text-secondary">Message info<\/span>/
        );
    });

    it("keeps the action line's height with no action at all", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).toMatch(/\.mt-brokk-card \.mt-brokk-ra \{\s*min-height: 24px;/);
        const bare = cardsOf(render(everyKind())).find((card) => card.includes('data-notif="info"'));
        expect(bare).toContain('data-testid="brokk-card-actions"');
    });

    it("names the source of every kind on the first line", () => {
        const sources = cardsOf(render(everyKind())).map(
            (card) => /data-testid="notification-source">([^<]*)</.exec(card)?.[1] ?? ""
        );
        expect(sources).toEqual(expect.arrayContaining(["CI", "build", "agent", "pull request", "hand-off"]));
        expect(sources.filter((s) => s === "")).toHaveLength(0);
    });
});

describe("a card that leads somewhere is a call to action (#2195, FR-MC-019 AC17)", () => {
    const done = () => cardsOf(render(everyKind())).find((card) => card.includes('data-info="done:b9"'));

    it("makes a Done card clickable as a whole, with the hover state of a call to action", () => {
        const card = done();
        const opening = card.slice(0, card.indexOf(">"));
        expect(opening).toContain('data-cta="true"');
        expect(opening).toContain('role="button"');
        expect(opening).toContain("cursor-pointer");
        expect(opening).toContain('tabindex="0"');
        const source = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(source).toContain("onClick={hasTarget ? onOpen : undefined}");
    });

    it("shows the Integration's Go to → on the right of a Done card, before its Archive", () => {
        const card = done();
        const goTo = tags(card, "notification-goto")[0];
        expect(goTo).toContain("rounded-4 border border-transparent");
        expect(goTo).toContain('title="Show Bérénice&#x27;s panel"');
        expect(card).toMatch(/data-testid="notification-goto"[^>]*>Go to<i class="fa fa-solid fa-arrow-right text-10"/);
        expect(card.indexOf('data-testid="notification-goto"')).toBeLessThan(
            card.indexOf('data-testid="notification-archive"')
        );
        expect(card.indexOf('data-testid="brokk-card-actions"')).toBeLessThan(card.indexOf("mt-brokk-ra-end"));
    });

    it("is the very component and wording of the Integration panel's agent bar", () => {
        const bar = readFileSync(join(__dirname, "..", "reviews", "reviews-agent-bar.tsx"), "utf8");
        expect(bar).toContain('import { BarButton, GoToButton } from "../go-to-button"');
        expect(bar).toContain('testId="reviews-agent-goto"');
        const button = readFileSync(join(__dirname, "..", "go-to-button.tsx"), "utf8");
        expect(button).toContain('{t("reviewsAgents.goTo")}');
        expect(button).toContain("fa-arrow-right");
        const panel = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(panel).toContain('import { GoToButton } from "../go-to-button"');
    });

    it("brings the agent's view and terminal forward from the Done card", () => {
        const source = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(source).toContain("actions.goToSession(finished.sessionid, row.key)");
        expect(source).toContain("model.goTo({");
    });

    it("leads from a notification that comes from somewhere, and not twice when its own action leads there", () => {
        const cards = cardsOf(render(everyKind()));
        const lead = cards.find((card) => card.includes('data-notif="lead"'));
        const done = cards.find((card) => card.includes('data-notif="done"'));
        const plain = cards.find((card) => card.includes('data-notif="info"'));
        expect(lead).toContain('data-testid="notification-goto"');
        expect(done).toContain('data-testid="notification-goto"');
        expect(plain).not.toContain('data-testid="notification-goto"');
        expect(plain.slice(0, plain.indexOf(">"))).not.toContain("data-cta");
        const own = render(
            rowsOf({}, [
                entry("goto", {
                    kind: "info",
                    workspaceid: "wsA",
                    blockid: "b1",
                    actions: [{ id: "g", label: "Go to Léa", kind: "open", workspaceid: "wsA", blockid: "b1" }],
                }),
            ] as any[])
        );
        expect(own).not.toContain('data-testid="notification-goto"');
        expect(own).toContain("data-cta");
    });

    it("leaves the cards that have their own buttons to those", () => {
        for (const key of ["agent:b1", "ci:/p:2", "ready:/p:3", "handoff:r1"]) {
            const card = cardsOf(render(everyKind())).find((c) => c.includes(`data-todo="${key}"`));
            expect(card, key).toBeDefined();
            expect(card, key).not.toContain('data-testid="notification-goto"');
            expect(card.slice(0, card.indexOf(">")), key).not.toContain("data-cta");
        }
    });

    it("stops the hover motion with reduced motion, the system's and MoltenTerm's own", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
        expect(media).toMatch(/\.mt-brokk-card\[data-cta\] \{\s*transition: none;/);
        expect(media).toMatch(/\.mt-brokk-card\[data-cta\]:hover,[^{]*\{\s*transform: none;/);
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-brokk-card\[data-cta\]:hover,[^{]*\{\s*transform: none;/);
        expect(css).toMatch(
            /\.mt-brokk-card\[data-cta\]:hover,\s*\.mt-brokk-card\[data-cta\]:focus-visible \{[^}]*transform: translateY\(-1px\);/
        );
    });
});
