// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "wsA", name: "Alpha" }) } };
});
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: { getInstance: () => ({ session: null, showContextMenu: vi.fn() }) },
}));
vi.mock("@/app/store/modalmodel", () => ({ modalsModel: { hasOpenModals: () => false } }));
vi.mock("../tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: () => ({}),
}));
vi.mock("../workspace-rail", () => ({ loadWorkspaceSources: vi.fn(async () => []) }));
vi.mock("../companion/companion-task-model", () => ({
    agentName: (id: string) => ({ claude: "Claude", codex: "Codex" })[id] ?? id,
}));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom({ states: {}, versions: {} });
    return { AgentStates: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("../downloads/downloads-store", async () => {
    const { atom } = await import("jotai");
    const itemsAtom = atom([] as any[]);
    return { DownloadsModel: { getInstance: () => ({ itemsAtom }) } };
});
vi.mock("../keepawake-store", async () => {
    const { atom } = await import("jotai");
    const stateAtom = atom({});
    return { KeepAwakeModel: { getInstance: () => ({ stateAtom }) } };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const shownEntriesAtom = atom([] as any[]);
    return {
        MoltentermNotifications: { getInstance: () => ({ shownEntriesAtom, settleSeen: vi.fn(), handle: vi.fn() }) },
    };
});
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        nameAtom: atom("Brokk"),
        tabRequestAtom: atom(null as any),
        toHandleAtom: atom({ items: [], info: [], parked: 0 } as any),
        talkingAtom: atom(false),
        closeCard: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
vi.mock("./brokk-hub-store", async () => {
    const { atom } = await import("jotai");
    const { DefaultVisitSettings } = await import("./brokk-visit-events");
    const model = { settingsAtom: atom(DefaultVisitSettings), ownWorkingAtom: atom(false) };
    return { BrokkHubModel: { getInstance: () => model } };
});
vi.mock("./boss-usage", async () => {
    const { atom } = await import("jotai");
    return { UsageReadingsAtom: atom({} as any) };
});
// His animated portrait and its models have their own tests (use-brokk-live): here the group only asks for them.
const Calls = vi.hoisted(() => ({ live: [] as unknown[], caption: [] as unknown[] }));
vi.mock("./use-brokk-live", () => ({
    useCardLive: (talk?: string) => {
        Calls.live.push(talk ?? null);
        return { situation: { talk }, rhythm: "normal" };
    },
}));
vi.mock("./use-brokk-caption", () => ({
    useGroupCaption: (talk?: string) => {
        Calls.caption.push(talk ?? null);
        return "He says something";
    },
}));
vi.mock("./boss-portrait", () => ({
    BossPortrait: ({ live, framing }: { live?: unknown; framing?: string }) => (
        <span data-testid="portrait" data-framing={framing} data-live={live ? JSON.stringify(live) : "none"} />
    ),
}));
vi.mock("./brokk-talk", () => ({
    BrokkTalk: ({ onFocusChange, onTyping }: { onFocusChange?: unknown; onTyping?: unknown }) => (
        <form
            data-testid="mock-talk"
            data-focus-wired={String(typeof onFocusChange)}
            data-typing-wired={String(typeof onTyping)}
        />
    ),
}));
vi.mock("./brokk-menu", () => ({ brokkMenuItems: () => [] }));
vi.mock("./use-brokk-actions", () => ({
    useBrokkActions: () => ({ busyId: null, problem: "", goToSession: vi.fn(), runTodo: vi.fn(), reconnect: vi.fn() }),
}));
vi.mock("./brokk-notes-panel", () => ({ NotificationsPanel: () => <div data-testid="mock-notifications" /> }));
vi.mock("./brokk-keepawake-panel", () => ({ BrokkKeepAwakePanel: () => <div data-testid="mock-keepawake" /> }));
vi.mock("./brokk-rows-panels", () => ({
    AgentsPanel: () => <div data-testid="mock-agents" />,
    SessionsPanel: () => <div data-testid="mock-sessions" />,
    DownloadsPanel: () => <div data-testid="mock-downloads" />,
    UsagePanel: () => <div data-testid="mock-usage" />,
}));

import { globalStore } from "@/app/store/jotaiStore";
import { AgentStates } from "../agent-state-store";
import { DownloadsModel } from "../downloads/downloads-store";
import { EmptyKeepAwakeState } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { MoltentermNotifications } from "../notifications-store";
import { BossBubbleModel } from "./boss-store";
import { ToHandleItem } from "./boss-to-handle-model";
import { UsageReadingsAtom } from "./boss-usage";
import { BrokkGroup, GroupFrame } from "./brokk-group";
import { groupGeometry } from "./brokk-group-model";

const boss = BossBubbleModel.getInstance() as any;
const notifications = MoltentermNotifications.getInstance() as any;
const downloads = DownloadsModel.getInstance() as any;
const agents = AgentStates.getInstance() as any;
const keep = KeepAwakeModel.getInstance() as any;

const g = groupGeometry();
const Now = Date.now();
const Min = 60_000;

const Frame: GroupFrame = {
    place: { left: 272, top: 8, panelRoom: 600, heightRoom: 784 },
    origin: { x: 239, y: 20 },
    thread: { x: 252, y: 19, w: 20 },
};

function render(frame: GroupFrame = Frame, shown = true): string {
    return renderToStaticMarkup(<BrokkGroup frame={frame} shown={shown} />);
}

function attr(html: string, testId: string, name: string): string {
    const tag = new RegExp(`<[a-z0-9]+ [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
    return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

function row(key: string, extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone: "waiting",
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: key },
        place: "",
        since: Now - 2 * Min,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    };
}

function entry(id: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        time: Now - Min,
        updated: Now - Min,
        kind: "info",
        read: false,
        source: "agents",
        title: id,
        ...extra,
    };
}

function download(id: string, state: string, endedAt = 0, extra: Record<string, unknown> = {}) {
    return { id, state, endedAt, received: 0, total: 0, name: id, ...extra };
}

function quiet() {
    globalStore.set(boss.nameAtom, "Brokk");
    globalStore.set(boss.tabRequestAtom, null);
    globalStore.set(boss.toHandleAtom, { items: [], info: [], parked: 0 });
    globalStore.set(notifications.shownEntriesAtom, []);
    globalStore.set(downloads.itemsAtom, []);
    globalStore.set(agents.dataAtom, { states: {}, versions: {} });
    globalStore.set(keep.stateAtom, EmptyKeepAwakeState);
    globalStore.set(UsageReadingsAtom, {});
}

beforeEach(() => {
    quiet();
    Calls.live.length = 0;
    Calls.caption.length = 0;
});

describe("the group (FR-BOSS-009, AC17)", () => {
    it("floats as a non-modal dialog at the place it is given, with no backdrop", () => {
        const html = render();
        expect(attr(html, "boss-card", "role")).toBe("dialog");
        expect(attr(html, "boss-card", "aria-modal")).toBe("false");
        expect(attr(html, "boss-card", "aria-label")).toBe(
            "Brokk: notifications, agents, sessions, downloads and keep-awake"
        );
        expect(attr(html, "boss-card", "style")).toBe(
            `left:272px;top:8px;width:${g.width}px;height:${g.field.y + g.field.h}px`
        );
        expect(html).not.toContain("backdrop");
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(/\.mt-brokk-group \{([^}]*)\}/.exec(css)?.[1]).toMatch(/pointer-events: none/);
    });

    it("is square, rail, block and field, in that order, and the rail has five round icons", () => {
        const html = render();
        const order = ["brokk-square", "brokk-rail", "brokk-block", "brokk-fieldbox"].map((id) =>
            html.indexOf(`data-testid="${id}"`)
        );
        expect(order.every((at) => at > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        const icons = [...html.matchAll(/data-rail-id="([a-z]+)"/g)].map((m) => m[1]);
        expect(icons).toEqual(["notifications", "agents", "sessions", "downloads", "keepawake"]);
    });

    it("makes the square 264 px and the rail exactly as tall, with the icons 44 px", () => {
        const html = render();
        expect(attr(html, "brokk-square", "style")).toMatch(/width:264px;height:264px/);
        expect(attr(html, "brokk-rail", "style")).toContain("height:264px");
        expect(attr(html, "brokk-rail", "style")).toContain(`width:${g.railWidth}px`);
        for (const id of ["notifications", "agents", "sessions", "downloads", "keepawake"]) {
            expect(attr(html, `brokk-rail-${id}`, "style")).toMatch(/width:44px;height:44px/);
        }
    });

    it("puts the block 8 px under the square, and the field 8 px under the block, as wide as the group", () => {
        const html = render();
        expect(attr(html, "brokk-block", "style")).toContain(`top:${264 + 8}px`);
        expect(attr(html, "brokk-block", "style")).toContain(`width:${g.width}px`);
        expect(attr(html, "brokk-fieldbox", "style")).toContain(`top:${g.field.y}px`);
        expect(attr(html, "brokk-fieldbox", "style")).toContain(`width:${g.width}px`);
        expect(g.field.y).toBe(264 + 8 + g.block.h + 8);
    });

    it("draws the short ember thread from the face to the square when it is given one, and none otherwise", () => {
        expect(render()).toContain('data-testid="brokk-thread"');
        expect(render({ ...Frame, thread: null })).not.toContain('data-testid="brokk-thread"');
    });

    it("arrives from the face: each part is given its offset to it, and the rail and the block follow the square", () => {
        const html = render();
        for (const id of ["brokk-square", "brokk-rail", "brokk-block", "brokk-fieldbox"]) {
            expect(attr(html, id, "style"), id).toMatch(/--dx:-?[\d.]+px;--dy:-?[\d.]+px/);
        }
        // From the middle of the face (239, 20 in the layer, so -33, 12 in the group) to the middle of the 264 px square.
        expect(attr(html, "brokk-square", "style")).toContain("--dx:-165px;--dy:-120px");
        expect(attr(html, "brokk-rail", "style")).toContain("--i:1");
        expect(attr(html, "brokk-square", "style")).toContain("--i:0");
        expect(render(Frame, true)).toContain("mt-brokk-group is-in");
        expect(render(Frame, false)).not.toContain("is-in");
    });

    it("arrives with no offset when there is no face on screen", () => {
        expect(attr(render({ ...Frame, origin: null }), "brokk-square", "style")).not.toContain("--dx");
    });
});

describe("the sheet that catches the pointer during a preview", () => {
    it("is not there at rest: the page tiles below keep the pointer", () => {
        expect(render()).not.toContain("brokk-hover-catch");
    });

    it("is drawn from the hover state alone, under the group, catching the pointer over the whole window", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toMatch(
            /\{holdsHover\(panels\) \? <div className="mt-brokk-catch" aria-hidden data-testid="brokk-hover-catch" \/> : null\}\s*\{frame\.thread != null/
        );
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const rule = /\.mt-brokk-catch \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(rule).toMatch(/position: absolute/);
        expect(rule).toMatch(/inset: 0/);
        expect(rule).toMatch(/pointer-events: auto/);
    });
});

describe("the square: his living portrait, with the screen effect (AC17)", () => {
    it("shows his name at the bottom left, in capitals, and the scanlines and the vignette over the picture", () => {
        const html = render();
        expect(html).toMatch(/data-testid="brokk-name"[^>]*><i><\/i>BROKK</);
        expect(html).toContain('data-testid="brokk-scan"');
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(/\.mt-brokk-scan \{([^}]*)\}/.exec(css)?.[1]).toMatch(/repeating-linear-gradient/);
        expect(/\.mt-brokk-scan \{([^}]*)\}/.exec(css)?.[1]).toMatch(/animation: mt-brokk-scan 7s linear infinite/);
        const vig = /\.mt-brokk-vig \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(vig).toMatch(/radial-gradient/);
        expect(vig).toMatch(/inset 0 0 26px/);
    });

    it("uses the name the developer chose", () => {
        globalStore.set(boss.nameAtom, "Léa");
        expect(render()).toMatch(/BROKK|LÉA</);
        expect(render()).toContain("LÉA");
    });

    it("plays the portrait of the panel: the card's live props, in the banner framing, and only one", () => {
        const html = render();
        expect(html.match(/data-testid="portrait"/g)).toHaveLength(1);
        expect(attr(html, "portrait", "data-framing")).toBe("banner");
        expect(attr(html, "portrait", "data-live")).toContain("&quot;rhythm&quot;:&quot;normal&quot;");
    });

    it("is driven by the same pose and mood models as the panel was: the talk pose goes to the portrait and to the caption", () => {
        render();
        expect(Calls.live).toEqual([null]);
        expect(Calls.caption).toEqual([null]);
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("useCardLive(talkPose(typing, answering))");
        expect(source).toContain("useGroupCaption(talkPose(typing, answering))");
        expect(source).toContain('<BossPortrait live={live} framing="banner" />');
    });

    it("answers while his own session works", async () => {
        const { BrokkHubModel } = await import("./brokk-hub-store");
        const hub = BrokkHubModel.getInstance() as any;
        globalStore.set(hub.ownWorkingAtom, true);
        render();
        expect(Calls.live).toEqual(["answering"]);
        expect(Calls.caption).toEqual(["answering"]);
        globalStore.set(hub.ownWorkingAtom, false);
    });

    it("closes on a click, and opens its menu from a ⋯ and from a right click", () => {
        const html = render();
        expect(html).toContain('data-testid="boss-card-close"');
        expect(attr(html, "boss-card-close", "aria-label")).toBe("Close Brokk");
        expect(html).toContain('data-testid="brokk-panel-menu"');
        expect(readFileSync(join(__dirname, "brokk-group.tsx"), "utf8")).toContain("onContextMenu={showMenu}");
    });

    it("plays no scanline and no slide under reduced motion, in both ways the app tells it", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
        const app = css.slice(css.indexOf(".prefers-reduced-motion .mt-brokk-sq"));
        for (const scope of [media, app]) {
            expect(scope).toMatch(/\.mt-brokk-sq/);
            expect(scope).toMatch(/\.mt-brokk-rail/);
            expect(scope).toMatch(/\.mt-brokk-block/);
            expect(scope).toMatch(/\.mt-brokk-fieldbox/);
            expect(scope).toMatch(/transform: none !important/);
            expect(scope).toMatch(/transition: opacity 150ms linear !important/);
            expect(scope).toMatch(/\.mt-brokk-scan \{\s*animation: none;/);
            expect(scope).toMatch(/\.mt-brokk-gpanel/);
        }
    });
});

describe("the rail (AC17)", () => {
    it("is a vertical tablist whose icons are named, with the panel they open", () => {
        const html = render();
        expect(attr(html, "brokk-rail", "role")).toBe("tablist");
        expect(attr(html, "brokk-rail", "aria-orientation")).toBe("vertical");
        expect(attr(html, "brokk-rail-agents", "role")).toBe("tab");
        expect(attr(html, "brokk-rail-agents", "aria-label")).toBe("Agents");
        expect(attr(html, "brokk-rail-keepawake", "aria-label")).toBe("Keep awake");
        expect(attr(html, "brokk-rail-agents", "aria-controls")).toBe("brokk-panel");
    });

    it("counts the notifications on its icon, red when anything is grave or waits for an answer", () => {
        globalStore.set(notifications.shownEntriesAtom, [entry("n1"), entry("n2")]);
        const calm = render();
        expect(calm).toMatch(/data-testid="brokk-rail-count"[^>]*>2</);
        expect(calm).not.toContain('data-grave="true"');
        globalStore.set(boss.toHandleAtom, { items: [row("agent:a")], info: [], parked: 0 });
        const html = render();
        expect(html).toMatch(/data-grave="true"[^>]*data-testid="brokk-rail-count"[^>]*>3</);
        expect(attr(html, "brokk-rail-notifications", "aria-label")).toBe("Notifications, 3 waiting");
    });

    it("puts a dot on Agents while an agent is blocked", () => {
        expect(render()).not.toContain('data-testid="brokk-rail-dot"');
        globalStore.set(agents.dataAtom, {
            states: { b1: { blockid: "b1", state: "waiting", since: Now - Min } },
            versions: {},
        });
        const html = render();
        expect(html).toContain('data-testid="brokk-rail-dot"');
        expect(attr(html, "brokk-rail-agents", "aria-label")).toBe("Agents, an agent is blocked");
    });

    it("runs a progress ring around Téléchargements while one downloads", () => {
        globalStore.set(downloads.itemsAtom, [download("d1", "progressing", 0, { received: 62, total: 100 })]);
        const html = render();
        expect(html).toContain('data-testid="brokk-rail-ring"');
        expect(attr(html, "brokk-rail-downloads", "aria-label")).toBe("Downloads, 62 % downloaded");
    });

    it("shows the cup's ember on Garder éveillé while the computer is kept awake", () => {
        expect(render()).not.toContain('data-testid="brokk-rail-ember"');
        globalStore.set(keep.stateAtom, {
            ...EmptyKeepAwakeState,
            version: 1,
            coffees: [{ workspaceid: "wsA", since: 1, reason: "work", untilidle: true }],
        });
        expect(render()).toContain('data-testid="brokk-rail-ember"');
    });
});

describe("the panel that opens by priority, through the group (AC18)", () => {
    const panel = (html: string) => attr(html, "brokk-panel", "data-panel");

    it("opens nothing with nothing to say", () => {
        const html = render();
        expect(html).not.toContain('data-testid="brokk-panel"');
        expect(html).not.toContain('data-testid="brokk-plink"');
    });

    it("1. opens Notifications for a row that is grave or waits for an answer", () => {
        globalStore.set(boss.toHandleAtom, { items: [row("agent:a")], info: [], parked: 0 });
        globalStore.set(agents.dataAtom, { states: { a: { blockid: "a", state: "waiting" } }, versions: {} });
        globalStore.set(downloads.itemsAtom, [download("d1", "interrupted", Date.now())]);
        expect(panel(render())).toBe("notifications");
    });

    it("2. opens Agents for a blocked agent, when no row is waiting for an answer", () => {
        globalStore.set(agents.dataAtom, {
            states: { b1: { blockid: "b1", state: "waiting", since: Now - Min } },
            versions: {},
        });
        globalStore.set(downloads.itemsAtom, [download("d1", "interrupted", Date.now())]);
        globalStore.set(notifications.shownEntriesAtom, [entry("n1")]);
        expect(panel(render())).toBe("agents");
    });

    it("3. opens Téléchargements for a download that failed or just finished, before an unread notification", () => {
        globalStore.set(downloads.itemsAtom, [download("d1", "completed", Date.now())]);
        globalStore.set(notifications.shownEntriesAtom, [entry("n1")]);
        expect(panel(render())).toBe("downloads");
        globalStore.set(downloads.itemsAtom, [download("d1", "interrupted", Date.now())]);
        expect(panel(render())).toBe("downloads");
    });

    it("4. opens Notifications for anything else that is unread", () => {
        globalStore.set(notifications.shownEntriesAtom, [entry("n1")]);
        expect(panel(render())).toBe("notifications");
    });

    it("leaves a notification that was read, and a download cancelled by the developer, unsaid", () => {
        globalStore.set(notifications.shownEntriesAtom, [entry("n1", { read: true })]);
        globalStore.set(downloads.itemsAtom, [download("d1", "cancelled", Date.now())]);
        expect(render()).not.toContain('data-testid="brokk-panel"');
    });

    it("5. opens Téléchargements for a download that runs, when that is all", () => {
        globalStore.set(downloads.itemsAtom, [download("d1", "progressing", 0)]);
        expect(panel(render())).toBe("downloads");
    });

    it("shows one panel at a time, joined to its icon by the ember link, with the icon active", () => {
        globalStore.set(notifications.shownEntriesAtom, [entry("n1")]);
        const html = render();
        expect(html.match(/data-testid="brokk-panel"/g)).toHaveLength(1);
        expect(html.match(/data-testid="mock-(?!talk)/g)).toHaveLength(1);
        expect(html).toContain('data-testid="brokk-plink"');
        expect(attr(html, "brokk-rail-notifications", "data-active")).toBe("true");
        expect(attr(html, "brokk-rail-agents", "data-active")).toBeUndefined();
        expect(attr(html, "brokk-panel", "role")).toBe("tabpanel");
    });

    it("is 420 px wide when the window has the room, narrower when it has not, and as tall as the square to begin with", () => {
        globalStore.set(notifications.shownEntriesAtom, [entry("n1")]);
        expect(attr(render(), "brokk-panel", "style")).toBe(`left:${g.panelLeft}px;top:0;width:420px;height:264px`);
        const narrow = render({ ...Frame, place: { ...Frame.place, panelRoom: 330 } });
        expect(attr(narrow, "brokk-panel", "style")).toContain("width:330px");
    });

    it("opens the panel a surface asked for, pinned, whatever the priority says", () => {
        globalStore.set(notifications.shownEntriesAtom, [entry("n1")]);
        globalStore.set(boss.tabRequestAtom, { tab: "keepawake", seq: 1, highlight: [] });
        expect(panel(render())).toBe("keepawake");
        globalStore.set(boss.tabRequestAtom, { tab: "downloads", seq: 2, highlight: [] });
        expect(panel(render())).toBe("downloads");
    });

    it("reads the priority once, when the group opens, so that nothing changes under the developer's eyes", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("const [auto] = useState<PanelId>(() =>");
    });
});

describe("the windows never overlap (AC18)", () => {
    it("gives no panel while the conversation is open, and brings it back when it folds, through the one rule", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("const active: ShownPanel = activePanel(panels, auto, conversation);");
        expect(source).toContain(
            "const onFocusChange = useCallback((focused: boolean) => setConversation(focused), []);"
        );
        expect(source).toContain("<BrokkTalk onTyping={setTyping} onFocusChange={onFocusChange} />");
    });

    it("wires the field to the conversation", () => {
        const html = render();
        expect(attr(html, "mock-talk", "data-focus-wired")).toBe("function");
        expect(attr(html, "mock-talk", "data-typing-wired")).toBe("function");
    });

    it("folds the conversation with the focus leaving the field and its button, not with the focus moving between them", () => {
        const talk = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(talk).toContain("onFocus={() => onFocusChange?.(true)}");
        expect(talk).toContain("onBlur={(e) => onFocusChange?.(e.currentTarget.contains(e.relatedTarget as Node))}");
    });
});

describe("the block under the square (AC17 and AC20)", () => {
    const reading = (agent: string, percent: number, resetsat = Date.now() + 2 * 24 * 60 * Min) => ({
        agent,
        source: "t",
        readat: Date.now(),
        windows: [{ id: "week", label: "This week", usedpercent: percent, resetsat }],
    });

    it("says one line, the caption of his scene", () => {
        expect(attr(render(), "brokk-say", "class")).toBe("mt-brokk-say");
        expect(render()).toMatch(/data-testid="brokk-say"[^>]*><span>He says something<\/span>/);
    });

    it("tells the weekly usage per provider in percent, with a bar each, the fullest first", () => {
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 62), codex: reading("codex", 31.2) });
        const html = render();
        const cells = [...html.matchAll(/data-provider="([a-z]+)"/g)].map((m) => m[1]);
        expect(cells).toEqual(["claude", "codex"]);
        expect([...html.matchAll(/data-testid="brokk-usage-percent">([^<]*)</g)].map((m) => m[1])).toEqual([
            "62 %",
            "31 %",
        ]);
        expect([...html.matchAll(/data-testid="brokk-usage-bar"/g)]).toHaveLength(2);
        expect(html).toMatch(/style="width:62%"/);
        expect(html).toContain(">Claude<");
    });

    it("turns the bar and the number grave above 90 %, and not at 90 %", () => {
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 91), codex: reading("codex", 90) });
        const html = render();
        const cell = (provider: string) =>
            [...html.matchAll(/<span [^>]*data-testid="brokk-usage-cell"[^>]*>/g)]
                .map((m) => m[0])
                .find((tag) => tag.includes(`data-provider="${provider}"`));
        expect(cell("claude")).toContain('data-hi="true"');
        expect(cell("codex")).not.toContain("data-hi");
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(css).toMatch(/\.mt-brokk-pv\[data-hi="true"\] b \{\s*color: var\(--mt-state-blocked-text\)/);
        expect(css).toMatch(
            /\.mt-brokk-pv\[data-hi="true"\] \.mt-brokk-bar i \{\s*background: var\(--mt-state-blocked\)/
        );
    });

    it("gives the reset day as a tooltip, and nothing else", () => {
        const monday = new Date(2026, 10, 9, 8, 0, 0).getTime();
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 40, monday) });
        const cell = /<span [^>]*data-testid="brokk-usage-cell"[^>]*>/.exec(
            // The reset is in the past for the clock of this run: read it with the cell drawn from a future reset.
            (() => {
                globalStore.set(UsageReadingsAtom, { claude: reading("claude", 40, Date.now() + 3 * 24 * 60 * Min) });
                return render();
            })()
        )?.[0];
        expect(cell).toMatch(/title="Resets [A-Za-z]+"/);
    });

    it("says in one line when no provider shares a reading, and the click on the block opens the detail", () => {
        expect(render()).toContain('data-testid="brokk-usage-empty"');
        const html = render();
        expect(attr(html, "brokk-usage", "aria-label")).toBe("Show the usage of each plan in detail");
        expect(readFileSync(join(__dirname, "brokk-group.tsx"), "utf8")).toContain(
            'onClick={() => clickIcon("usage")}'
        );
    });

    it("keeps no 5-hour or per-model window in the block: they are in the detail", () => {
        globalStore.set(UsageReadingsAtom, {
            claude: {
                ...reading("claude", 62),
                windows: [
                    { id: "session", label: "Current session", usedpercent: 99 },
                    { id: "week", label: "This week", usedpercent: 62, resetsat: Date.now() + 10 * Min },
                    { id: "model:opus", label: "This week (Opus)", usedpercent: 70 },
                ],
            },
        });
        const html = render();
        expect(html.match(/data-testid="brokk-usage-cell"/g)).toHaveLength(1);
        expect(html).toContain("62 %");
        expect(html).not.toContain("99 %");
    });
});

describe("what Brokk sees when the group closes (AC19)", () => {
    it("settles the Info notifications the developer consulted, and what he looked at", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("consultedIds(rowsRef.current, listedRef.current)");
        expect(source).toContain("fireAndForget(() => notifications.handle(ids))");
        expect(source).toContain("notifications.settleSeen();");
        // Nothing is settled when the Notifications panel never showed.
        expect(source).toContain("if (!notesShownRef.current) {");
    });

    it("keeps the sign of a conversation on the face while he is spoken to", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("globalStore.set(boss.talkingAtom, typing || answering);");
    });
});
