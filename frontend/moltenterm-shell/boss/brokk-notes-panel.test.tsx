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

    it("lists the notifications, each with its × and silence actions", () => {
        globalStore.set(model.entriesAtom, [entry("n1", { source: "ci" }), entry("n2", { source: "build" })]);
        const html = render();
        expect(html.match(/data-testid="notification-row"/g)).toHaveLength(2);
        expect(html).toContain('data-notif="n1"');
        expect(html.match(/data-testid="notification-clear"/g)).toHaveLength(2);
        expect(html).toContain('aria-label="Clear"');
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

    it("keeps the rows To handle: an agent that waits, with its Go to, Later and Ignorer", () => {
        const html = render(rowsOf({ items: [todo("agent:b1")] }));
        expect(tags(html, "boss-card-todo-row")).toHaveLength(1);
        expect(html).toContain('data-todo="agent:b1"');
        expect(tags(html, "boss-card-todo-action").map((t) => /data-act="([^"]*)"/.exec(t)[1])).toEqual(["goto"]);
        expect(html).toContain('data-testid="boss-card-todo-later"');
        expect(html).toContain('data-testid="boss-card-todo-ignore"');
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
        for (const id of ["notification-mark-all-read", "notification-clear-all", "notification-settings-link"]) {
            const tag = tags(html, id)[0];
            expect(tag, id).toMatch(/aria-label="[^"]+"/);
            expect(tag, id).toMatch(/title="[^"]+"/);
        }
        expect(html).toContain(
            'title="Moves every notification of the list to the archive. You can undo it for a few seconds."'
        );
    });

    it("offers Clear all while the list has notifications, and not on an empty one (#2026)", () => {
        expect(render()).not.toContain('data-testid="notification-clear-all"');
        globalStore.set(model.entriesAtom, [entry("n1")]);
        expect(render()).toContain('data-testid="notification-clear-all"');
    });

    it("clears the notifications of the list with an undo toast, never a confirmation, and leaves what waits for an answer", () => {
        const source = readFileSync(join(__dirname, "brokk-notes-panel.tsx"), "utf8");
        expect(source).toContain("const undo = model.clear(ids);");
        expect(source).toContain('showUndoToast(translateCount("notif.center.cleared", ids.length), undo)');
        expect(source).toContain("const ids = entryRows.map((row) => row.entry.id);");
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

    it("puts the × last on a notification's row, after its actions", () => {
        globalStore.set(model.entriesAtom, [
            entry("n1", { actions: [{ id: "a", label: "Open the log", kind: "gesture", gesture: "x" }] }),
        ]);
        const html = render();
        expect(html.indexOf('data-testid="notification-action"')).toBeLessThan(
            html.indexOf('data-testid="notification-clear"')
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
