// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    const ringAtom = atom((get) => get(itemsAtom).filter((r) => r.state === "progressing" || r.state === "paused"));
    const transfersAtom = atom([] as any[]);
    return { DownloadsModel: { getInstance: () => ({ itemsAtom, ringAtom, transfersAtom }) } };
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
        cardPinnedAtom: atom(true),
        toHandleAtom: atom({ items: [], info: [], parked: 0 } as any),
        talkingAtom: atom(false),
        closeCard: vi.fn(),
        pinCard: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
vi.mock("./brokk-hub-store", async () => {
    const { atom } = await import("jotai");
    const { DefaultVisitSettings } = await import("./brokk-visit-events");
    const model = {
        settingsAtom: atom(DefaultVisitSettings),
        ownWorkingAtom: atom(false),
        faceHover: { enterGroup: vi.fn(), leaveGroup: vi.fn(), groupGone: vi.fn() },
    };
    return { BrokkHubModel: { getInstance: () => model } };
});
vi.mock("./boss-usage", async () => {
    const { atom } = await import("jotai");
    return { UsageReadingsAtom: atom({} as any), UsageUnreadableAtom: atom({} as any) };
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
    BrokkTalk: ({
        onFocusChange,
        onTyping,
        onContentHeight,
    }: {
        onFocusChange?: unknown;
        onTyping?: unknown;
        onContentHeight?: unknown;
    }) => (
        <form
            data-testid="mock-talk"
            data-focus-wired={String(typeof onFocusChange)}
            data-typing-wired={String(typeof onTyping)}
            data-height-wired={String(typeof onContentHeight)}
        />
    ),
}));
// His session's exchange has its own tests (brokk-session): here the group reads what it says and does.
vi.mock("./brokk-session", async () => {
    const { atom } = await import("jotai");
    const session = {
        stateAtom: atom({ phase: "idle", reason: "", agentName: "", started: false, reply: "", where: null } as any),
        exchangeAtom: atom([] as any[]),
        speakingAtom: atom(false),
        unseenIdAtom: atom(null as string),
    };
    return { BrokkSession: { getInstance: () => session } };
});
// What the face's badge counts, by key: the hub's own tests cover how it is made (brokk-hub-feed, brokk-visit).
const Badge = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("./use-brokk-hub", () => ({ useAvatarKeys: () => Badge.keys }));
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
}));

import { globalStore } from "@/app/store/jotaiStore";
import { AgentStates } from "../agent-state-store";
import { DownloadsModel } from "../downloads/downloads-store";
import { I18nModel } from "../i18n/i18n";
import { EmptyKeepAwakeState } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { MoltentermNotifications } from "../notifications-store";
import { BossBubbleModel } from "./boss-store";
import { ToHandleItem } from "./boss-to-handle-model";
import { UsageReadingsAtom, UsageUnreadableAtom } from "./boss-usage";
import { BrokkGroup, BrokkScrim, GroupFrame, rememberPanel, SayCard } from "./brokk-group";
import { ArrivalSteps, groupGeometry, PanelId, ReportSize, ReportView, reportView } from "./brokk-group-model";
import { BrokkSession } from "./brokk-session";

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
    const session = BrokkSession.getInstance() as any;
    globalStore.set(session.exchangeAtom, []);
    globalStore.set(session.unseenIdAtom, null);
    globalStore.set(session.speakingAtom, false);
    Badge.keys = [];
}

beforeEach(() => {
    quiet();
    rememberPanel(null);
    Calls.live.length = 0;
    Calls.caption.length = 0;
});

describe("the group (FR-BOSS-009, AC17)", () => {
    it("floats as a non-modal dialog at the place it is given, with no backdrop", () => {
        const html = render();
        expect(attr(html, "boss-card", "role")).toBe("dialog");
        expect(attr(html, "boss-card", "aria-modal")).toBe("false");
        expect(attr(html, "boss-card", "aria-label")).toBe(
            "Brokk: notifications, downloads, keep-awake, agents and sessions"
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
        expect(icons).toEqual(["notifications", "downloads", "keepawake", "agents", "sessions"]);
    });

    it("draws the Agents icon as the shared AI icon of the agent tabs, not a robot (AC60, #2108)", () => {
        const html = render();
        const agentsIcon = /<button[^>]*data-testid="brokk-rail-agents"[\s\S]*?<\/button>/.exec(html)[0];
        expect(agentsIcon).toContain("fa-sparkles");
        expect(agentsIcon).not.toContain("fa-robot");
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

    it("gives each part the step of the motion order, and the panel none: it shows with the square (#2082)", () => {
        globalStore.set(downloads.itemsAtom, [download("d1", "completed", Date.now())]);
        const html = render(Frame, false);
        expect(attr(html, "brokk-panel", "data-panel")).toBe("downloads");
        const steps: Record<string, number> = {
            "brokk-square": ArrivalSteps.square,
            "brokk-rail": ArrivalSteps.rail,
            "brokk-block": ArrivalSteps.block,
            "brokk-fieldbox": ArrivalSteps.field,
        };
        for (const [id, step] of Object.entries(steps)) {
            expect(attr(html, id, "style"), id).toContain(`--i:${step}`);
        }
        expect(ArrivalSteps.panel).toBe(0);
        expect(attr(html, "brokk-panel", "style")).not.toContain("--i");
        // Drawn with the group from its first frame, so its motion is the group's class, not a mount of its own.
        expect(html).toMatch(/class="mt-brokk-group"[\s\S]*data-testid="brokk-panel"/);
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
        expect(source).toContain(
            "const pose = talkPose({ typing, awaiting: talkWaits(talk), working: answering, speaking });"
        );
        expect(source).toContain("useCardLive(pose)");
        expect(source).toContain("useGroupCaption(pose)");
        expect(source).toContain('<BossPortrait live={live} framing="banner" />');
    });

    // FR-BOSS-009, AC25: listens while he is written to, thinks while his session works, speaks while his answer comes in.
    describe("his face with the conversation (AC25)", () => {
        const session = BrokkSession.getInstance() as any;

        afterEach(async () => {
            const { BrokkHubModel } = await import("./brokk-hub-store");
            globalStore.set((BrokkHubModel.getInstance() as any).ownWorkingAtom, false);
            globalStore.set(session.speakingAtom, false);
            globalStore.set(session.stateAtom, {
                phase: "idle",
                reason: "",
                agentName: "",
                started: false,
                reply: "",
                where: null,
            });
        });

        it("thinks while his own session works", async () => {
            const { BrokkHubModel } = await import("./brokk-hub-store");
            globalStore.set((BrokkHubModel.getInstance() as any).ownWorkingAtom, true);
            render();
            expect(Calls.live).toEqual(["thinking"]);
            expect(Calls.caption).toEqual(["thinking"]);
        });

        it("thinks from the moment his agent has a message, before his session shows work", () => {
            globalStore.set(session.stateAtom, {
                phase: "answering",
                reason: "",
                agentName: "",
                started: false,
                reply: "",
                where: null,
            });
            render();
            expect(Calls.live).toEqual(["thinking"]);
        });

        it("speaks while his answer comes in, over thinking", async () => {
            const { BrokkHubModel } = await import("./brokk-hub-store");
            globalStore.set((BrokkHubModel.getInstance() as any).ownWorkingAtom, true);
            globalStore.set(session.speakingAtom, true);
            render();
            expect(Calls.live).toEqual(["answering"]);
            expect(Calls.caption).toEqual(["answering"]);
        });
    });

    it("keeps the portrait his living one: the live props reach the portrait whatever the pose, never an image of its own", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).not.toContain("<img");
        expect(source).not.toContain("<video");
        expect(source).toContain("<BossPortrait live={live}");
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
            expect(scope).toMatch(/transition: opacity var\(--mt-duration-fade\) linear !important/);
            expect(scope).toMatch(/\.mt-brokk-scan \{\s*animation: none;/);
            expect(scope).toMatch(/\.mt-brokk-gpanel/);
            // The panel and its link fade with the group, the same short fade (#2082).
            expect(scope).toMatch(
                /\.mt-brokk-gpanel,\s*(\.prefers-reduced-motion )?\.mt-brokk-plink \{\s*animation: none !important;\s*transform: none !important;\s*transition: opacity var\(--mt-duration-fade\) linear !important;/
            );
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

    it("counts on Notifications what the face's badge counts, red when anything is grave or waits for an answer", () => {
        globalStore.set(boss.toHandleAtom, { items: [row("ready:/p:2", { tone: "success" })], info: [], parked: 0 });
        Badge.keys = ["ready:/p:2"];
        const calm = render();
        expect(calm).toMatch(/data-testid="brokk-rail-count"[^>]*>1</);
        expect(calm).not.toContain('data-grave="true"');
        globalStore.set(boss.toHandleAtom, {
            items: [row("ready:/p:2", { tone: "success" }), row("agent:a"), row("handoff:x")],
            info: [],
            parked: 0,
        });
        Badge.keys = ["agent:a", "ready:/p:2", "row:handoff:x"];
        const html = render();
        expect(html).toMatch(/data-grave="true"[^>]*data-testid="brokk-rail-count"[^>]*>3</);
        expect(attr(html, "brokk-rail-notifications", "aria-label")).toBe("Notifications, 3 waiting");
    });

    it("shows unread notifications the badge does not count as a dot, not a number", () => {
        globalStore.set(notifications.shownEntriesAtom, [entry("n1"), entry("n2")]);
        const html = render();
        expect(html).not.toContain('data-testid="brokk-rail-count"');
        expect(html).toContain('data-testid="brokk-rail-dot"');
    });

    it("counts a finished download of the badge on Téléchargements, and the counts add up to the badge (#2085)", () => {
        globalStore.set(boss.toHandleAtom, { items: [row("ready:/p:2", { tone: "success" })], info: [], parked: 0 });
        globalStore.set(downloads.itemsAtom, [
            download("d1", "completed", Date.now()),
            download("d2", "progressing", 0, { received: 10, total: 100 }),
        ]);
        Badge.keys = ["download:d1", "ready:/p:2"];
        const html = render();
        const counts = [...html.matchAll(/data-testid="brokk-rail-count"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
        expect(counts.reduce((a, b) => a + b, 0)).toBe(Badge.keys.length);
        expect(attr(html, "brokk-rail-downloads", "aria-label")).toBe("Downloads, 10 % downloaded");
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

    it("opens the notifications with nothing to say and no panel used yet: a panel is always open (#2090, AC60 #2108)", () => {
        const html = render();
        expect(panel(html)).toBe("notifications");
        expect(html).toContain('data-testid="brokk-plink"');
        expect(attr(html, "brokk-rail-notifications", "data-active")).toBe("true");
    });

    it("opens the panel used last when there is nothing to say, and the priority's when there is (#2090)", () => {
        rememberPanel("keepawake");
        expect(panel(render())).toBe("keepawake");
        // The former usage detail, remembered from before #2106, is no panel any more (AC58).
        rememberPanel("usage" as PanelId);
        expect(panel(render())).toBe("notifications");
        globalStore.set(notifications.shownEntriesAtom, [entry("n1")]);
        expect(panel(render())).toBe("notifications");
    });

    it("remembers the panel the developer pins, and switches to another when the open one is closed (#2090)", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("rememberPanel(panels.pinned);");
        expect(source).toContain("const closePanel = () => setPanels(afterClose(active, auto));");
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
        expect(panel(render())).toBe("notifications");
    });

    it("4. opens Notifications for a pull request ready to merge while a download runs, as in the gold (#2085)", () => {
        globalStore.set(boss.toHandleAtom, {
            items: [row("ready:/p:2080", { tone: "success", name: "#2080", line: { text: "[#2070] Collapsed…" } })],
            info: [],
            parked: 0,
        });
        globalStore.set(downloads.itemsAtom, [download("d1", "progressing", 0, { received: 40, total: 100 })]);
        Badge.keys = ["ready:/p:2080"];
        const html = render();
        expect(panel(html)).toBe("notifications");
        expect(html).toMatch(/data-testid="brokk-rail-count"[^>]*>1</);
        expect(attr(html, "brokk-rail-notifications", "aria-label")).toBe("Notifications, 1 waiting");
    });

    it("5. opens Téléchargements for a download that runs, when that is all, and the badge counts nothing", () => {
        globalStore.set(downloads.itemsAtom, [download("d1", "progressing", 0)]);
        const html = render();
        expect(panel(html)).toBe("downloads");
        expect(html).not.toContain('data-testid="brokk-rail-count"');
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
        expect(source).toContain(
            "const [auto] = useState<PanelId>(() => groupOpeningPanel(priorityFactsOf(railInput), rememberedPanel));"
        );
    });
});

describe("the windows never overlap (AC18)", () => {
    it("keeps the panel while the conversation is open, giving way above the field, and grows back when it folds (#2090)", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("const active: PanelId = activePanel(panels, auto);");
        expect(source).toContain("const heightRoom = panelRoom(g, frame.place.heightRoom, conversation);");
        expect(source).toContain("panelHeight(head + content + 16, heightRoom, Math.min(g.square, heightRoom))");
        expect(source).toContain("height: Math.min(height, heightRoom)");
        expect(source).toContain("const onFocusChange = useCallback((open: boolean) => setConversation(open), []);");
        expect(source).toContain("onFocusChange={onFocusChange}");
    });

    it("wires the field to the conversation: its opening, its typing and the height of its exchange", () => {
        const html = render();
        expect(attr(html, "mock-talk", "data-focus-wired")).toBe("function");
        expect(attr(html, "mock-talk", "data-typing-wired")).toBe("function");
        expect(attr(html, "mock-talk", "data-height-wired")).toBe("function");
    });

    it("opens with the focus and stays open with text in the field, and folds only when it is empty and unfocused", () => {
        const talk = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(talk).toContain("const open = conversationOpen(focused, text);");
        expect(talk).toContain("onFocus={() => setFocused(true)}");
        // The focus moving from the field to a button of the window is still the conversation.
        expect(talk).toContain("onBlur={(e) => setFocused(e.currentTarget.contains(e.relatedTarget as Node))}");
        expect(talk).toContain("onFocusChange?.(open);");
    });

    it("keeps the field in its place when the window is folded, the size of the group", () => {
        const html = render();
        expect(attr(html, "brokk-fieldbox", "style")).toContain(`width:${g.field.w}px;height:${g.field.h}px`);
        expect(attr(html, "brokk-fieldbox", "data-open")).toBe("false");
    });

    it("sizes the window from the group's geometry: as wide as the group and the panel area, as tall as its exchange", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("w: conversationWidth(g, frame.place.panelRoom),");
        expect(source).toContain(
            "h: conversationHeight(exchangeHeight + ConversationChromePx, frame.place.heightRoom - flow.field.y),"
        );
        expect(source).toContain("width: fieldSize.w,");
        expect(source).toContain("height: fieldSize.h,");
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
        expect(attr(render(), "brokk-say", "data-source")).toBe("activity");
    });

    // #2090, #2097: the card keeps two lines; a report that needs more makes the card itself taller while it is pointed
    // at or focused, in the group's flow, with no copy laid over it.
    describe("the card that grows to the whole report", () => {
        const Long =
            "Une chose pour vous : Adrien attend votre accord pour supprimer deux branches, et Léa a terminé sa revue de la PR.";
        // Five lines of 17 px, two of them kept at rest.
        const Cut: ReportSize = { full: 85, shown: 34 };
        const views = {
            rest: reportView(g, Cut, false, Frame.place.heightRoom),
            open: reportView(g, Cut, true, Frame.place.heightRoom),
            fits: reportView(g, { full: 34, shown: 34 }, true, Frame.place.heightRoom),
        };
        const card = (view: ReportView) => renderToStaticMarkup(<SayCard line={Long} source="activity" view={view} />);

        it("keeps the two lines at rest, and lets the keyboard reach a cut report", () => {
            const html = card(views.rest);
            expect(attr(html, "brokk-say", "data-cut")).toBe("true");
            expect(attr(html, "brokk-say", "tabindex")).toBe("0");
            expect(attr(html, "brokk-say", "role")).toBe("note");
            expect(attr(html, "brokk-say", "data-open")).toBeUndefined();
            expect(html).toContain(`<span style="height:34px">${Long}</span>`);
        });

        it("grows the card's own text to the whole report while it is pointed at", () => {
            const html = card(views.open);
            expect(attr(html, "brokk-say", "data-open")).toBe("true");
            expect(html).toContain(`<span style="height:85px">${Long}</span>`);
        });

        it("draws no overlay: the report is in the card once, whatever the state, and no rule or code is left for a copy", () => {
            for (const view of Object.values(views)) {
                const html = card(view);
                expect(html).not.toContain("brokk-say-full");
                expect(html.split(Long)).toHaveLength(2);
            }
            expect(render()).not.toContain("brokk-say-full");
            const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
            const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
            expect(css).not.toContain("say-full");
            expect(source).not.toContain("say-full");
            expect(css).not.toMatch(/\.mt-brokk-say[^{]*\{[^}]*position: absolute/);
        });

        it("changes nothing for a report that fits: no focus stop, no height, pointed at or not", () => {
            const html = card(views.fits);
            expect(attr(html, "brokk-say", "data-cut")).toBeUndefined();
            expect(attr(html, "brokk-say", "tabindex")).toBeUndefined();
            expect(attr(html, "brokk-say", "data-open")).toBeUndefined();
            expect(html).toContain(`<span>${Long}</span>`);
            expect(html).toBe(card(reportView(g, { full: 34, shown: 34 }, false, Frame.place.heightRoom)));
        });

        it("measures the report from its own text and the lines the card keeps, again when the report changes", () => {
            const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
            expect(source).toContain("full: text.scrollHeight,");
            expect(source).toContain("Math.round(lineHeight * ReportLines)");
            expect(source).toContain("}, [line, onSize]);");
            expect(source).not.toContain("text.clientHeight))");
        });

        it("is open for the pointer over the card or the keyboard on it, and a click's focus does not keep it open", () => {
            const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
            expect(source).toContain(
                "reportView(g, reportSize, reportHovered || reportFocused, frame.place.heightRoom)"
            );
            expect(source).toContain("onHover={setReportHovered}");
            expect(source).toContain("onFocusVisible={setReportFocused}");
            expect(source).toContain('onFocusVisible?.(e.currentTarget.matches(":focus-visible"))');
            expect(source).toContain("onPointerEnter={() => onHover?.(true)}");
            expect(source).toContain("onPointerLeave={() => onHover?.(false)}");
        });

        it("moves what stands under the card with it: the block's least height, the field's top and the group's height", () => {
            const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
            expect(source).toContain("const flow = groupFlow(g, report.growth);");
            expect(source).toContain("minHeight: flow.block.h,");
            expect(source).toContain("top: flow.field.y,");
            expect(source).toContain("height: flow.height }}");
            expect(source).toContain("frame.place.heightRoom - flow.field.y),");
        });

        it("rests as before when the card has not grown: same block, field and group sizes", () => {
            const html = render();
            expect(attr(html, "brokk-block", "style")).toContain(`min-height:${g.block.h}px`);
            expect(attr(html, "brokk-fieldbox", "style")).toContain(`top:${g.field.y}px`);
            expect(attr(html, "boss-card", "style")).toContain(`height:${g.field.y + g.field.h}px`);
            expect(html).toMatch(/data-testid="brokk-say"[^>]*><span>He says something<\/span>/);
        });

        it("keeps the panel where it is while the card grows: the field's resting top caps it, not the pushed one", () => {
            const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
            expect(source).toContain("const heightRoom = panelRoom(g, frame.place.heightRoom, conversation);");
        });

        it("grows smoothly, the text, the block and the field at one pace, and at once under reduced motion", () => {
            const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
            expect(css).toMatch(
                /\.mt-brokk-say > span:first-child \{[^}]*-webkit-line-clamp: 2;[^}]*transition: height var\(--mt-duration-settle\) var\(--mt-ease\);/
            );
            expect(css).toMatch(
                /\.mt-brokk-say\[data-open="true"\] > span:first-child \{\s*display: block;\s*-webkit-line-clamp: none;\s*overflow-y: auto;/
            );
            expect(css).toMatch(
                /\.mt-brokk-group\.is-in > \.mt-brokk-block \{[^}]*min-height var\(--mt-duration-settle\) var\(--mt-ease\);/
            );
            expect(/\.mt-brokk-fieldbox \{\s*overflow: visible;([^}]*)\}/.exec(css)?.[1]).toContain(
                "top var(--mt-duration-settle) var(--mt-ease)"
            );
            const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
            const app = css.slice(css.indexOf(".prefers-reduced-motion .mt-brokk-sq"));
            for (const scope of [media, app]) {
                expect(scope).toMatch(/\.mt-brokk-say > span:first-child \{\s*transition: none !important;/);
                expect(scope).toMatch(
                    /\.mt-brokk-block,\s*(?:\.prefers-reduced-motion )?\.mt-brokk-fieldbox \{\s*transform: none !important;\s*transition: opacity var\(--mt-duration-fade\) linear !important;/
                );
            }
        });
    });

    // FR-BOSS-009, AC25: his line comes from his session when he has something the developer has not seen.
    describe("the line from his session", () => {
        const session = BrokkSession.getInstance() as any;
        const answer = (text: string) => ({ id: "m1", role: "brokk", text, actions: [], at: 2, turn: 3, final: true });

        it("is the lead of his answer that came while the window was folded", () => {
            globalStore.set(session.exchangeAtom, [
                { id: "m1", role: "you", text: "any news?", at: 1 },
                answer("Olivia waits to delete 2 branches.\n\nShall I open the PR?"),
            ]);
            globalStore.set(session.unseenIdAtom, "m1");
            const html = render();
            expect(html).toMatch(/data-testid="brokk-say"[^>]*><span>Olivia waits to delete 2 branches\.<\/span>/);
            expect(attr(html, "brokk-say", "data-source")).toBe("session");
        });

        it("goes back to the activity summary once the developer has seen it", () => {
            globalStore.set(session.exchangeAtom, [
                { id: "m1", role: "you", text: "any news?", at: 1 },
                answer("Olivia waits."),
            ]);
            globalStore.set(session.unseenIdAtom, null);
            expect(render()).toMatch(/data-testid="brokk-say"[^>]*><span>He says something<\/span>/);
        });

        it("is not taken from the developer's own message with the same id", () => {
            globalStore.set(session.exchangeAtom, [{ id: "m1", role: "you", text: "any news?", at: 1 }]);
            globalStore.set(session.unseenIdAtom, "m1");
            expect(render()).toMatch(/data-testid="brokk-say"[^>]*><span>He says something<\/span>/);
        });
    });

    const cellTag = (html: string, provider: string) =>
        [...html.matchAll(/<span [^>]*data-testid="usage-week-row"[^>]*>/g)]
            .map((m) => m[0])
            .find((tag) => tag.includes(`data-provider="${provider}"`)) ?? "";
    // The seven day blocks of a row, in order: their fill and whether the reset mark stands before them.
    const blocksOf = (html: string, provider: string) => {
        const start = html.indexOf(cellTag(html, provider));
        const rowHtml = html.slice(start, html.indexOf("usage-week-percent", start));
        return [
            ...rowHtml.matchAll(/<span ([^>]*data-testid="usage-week-block"[^>]*)><i style="width:([0-9.]+)%"/g),
        ].map((m) => ({ fill: Number(m[2]), reset: m[1].includes('data-reset="true"') }));
    };

    // #2100: the week grid of AC48 to AC51.
    it("draws a week grid: the initials once, today marked, a row per provider with its logo, 7 blocks and the percent", () => {
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 73), codex: reading("codex", 31.2) });
        const html = render();
        expect([...html.matchAll(/data-testid="usage-week-day"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
            "M",
            "T",
            "W",
            "T",
            "F",
            "S",
            "S",
        ]);
        const today = (new Date().getDay() + 6) % 7;
        const days = [...html.matchAll(/<span [^>]*data-testid="usage-week-day"[^>]*>/g)].map((m) => m[0]);
        expect(days.map((tag) => tag.includes('data-today="true"'))).toEqual(
            Array.from({ length: 7 }, (_, i) => i === today)
        );
        expect(
            [...html.matchAll(/data-testid="usage-week-row"[^>]*data-provider="([a-z]+)"/g)].map((m) => m[1])
        ).toEqual(["claude", "codex"]);
        expect([...html.matchAll(/data-testid="usage-week-percent">([^<]*)</g)].map((m) => m[1])).toEqual([
            "73 %",
            "31 %",
        ]);
        expect([...html.matchAll(/data-testid="usage-week-block"/g)]).toHaveLength(14);
        // The fixture's week resets in two days: its fill starts on that weekday's block and wraps round the week.
        const start = (today + 2) % 7;
        const fromStart = [100, 100, 100, 100, 100, 11, 0];
        expect(blocksOf(html, "claude").map((b) => b.fill)).toEqual(
            Array.from({ length: 7 }, (_, i) => fromStart[(i - start + 7) % 7])
        );
        expect(blocksOf(html, "claude").map((b) => b.reset)).toEqual(Array.from({ length: 7 }, (_, i) => i === start));
        expect([...html.matchAll(/data-logo="([a-z]+)"/g)].map((m) => m[1])).toEqual(["claude", "ai"]);
        expect(html).not.toContain("brokk-usage-bar");
    });

    // The tests run without a DOM: the popover itself (a floating portal) is checked through its source and its style.
    it("names each agent's logo in a small popover on hover", () => {
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 40), codex: reading("codex", 20) });
        const html = render();
        const logos = [...html.matchAll(/<span [^>]*data-testid="usage-week-logo"[^>]*>/g)].map((m) => m[0]);
        expect(logos.map((tag) => /data-name="([^"]*)"/.exec(tag)?.[1])).toEqual(["Claude", "Codex"]);
        expect(logos.every((tag) => !tag.includes("title="))).toBe(true);
        expect(attr(html, "brokk-usage", "title")).toBeUndefined();
        const grid = readFileSync(join(__dirname, "../usage-week/usage-week.tsx"), "utf8");
        expect(grid).toContain("useHover(context, { delay: { open: NameDelayMs, close: 0 } })");
        expect(grid).toContain("onOpenChange: setOpen,");
        expect(grid).toMatch(/<FloatingPortal>\s*<span[^>]*className="mt-uw-name"/);
        const group = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(group).toContain("name: agentName(provider)");
        const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        expect(css).toMatch(
            /\.mt-uw-name \{[^}]*border: 1px solid var\(--mt-line-2\);[^}]*background: var\(--mt-surface-2\);\s*color: var\(--mt-text-1\);[^}]*pointer-events: none;/
        );
    });

    it("names each row for a screen reader, with no tooltip", () => {
        const resetsat = Date.now() + 3 * 24 * 60 * Min;
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 73, resetsat) });
        const html = render();
        const day = new Date(resetsat).toLocaleDateString("en", { weekday: "long" });
        expect(cellTag(html, "claude")).toContain(`aria-label="Claude, 73 %, resets ${day}"`);
        expect(cellTag(html, "claude")).toContain('role="img"');
        expect(cellTag(html, "claude")).not.toContain("title=");
        expect(attr(html, "usage-week-day", "aria-hidden")).toBe("true");
    });

    it("starts each row on its reset day's block (0 %), ringed, and fills forward round the week", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            // Wednesday 11 November 2026: the week runs from Monday 9 to Sunday 15.
            vi.setSystemTime(new Date(2026, 10, 11, 10, 0));
            // 66 % of a week resetting on Friday: Fri, Sat, Sun, Mon full, Tue partly.
            const friday = new Date(2026, 10, 13, 9, 0).getTime();
            globalStore.set(UsageReadingsAtom, { claude: reading("claude", 66, friday) });
            let blocks = blocksOf(render(), "claude");
            expect(blocks.map((b) => b.reset)).toEqual([false, false, false, false, true, false, false]);
            expect(blocks.map((b) => b.fill)).toEqual([100, 62, 0, 0, 100, 100, 100]);
            // 31 % of a week resetting on Monday: Mon, Tue full, Wed partly.
            globalStore.set(UsageReadingsAtom, {
                claude: reading("claude", 31, new Date(2026, 10, 16, 1, 0).getTime()),
            });
            blocks = blocksOf(render(), "claude");
            expect(blocks.map((b) => b.reset)).toEqual([true, false, false, false, false, false, false]);
            expect(blocks.map((b) => b.fill)).toEqual([100, 100, 17, 0, 0, 0, 0]);
            // 50 % of a week resetting on Sunday: Sun full, then Mon, Tue full, Wed half.
            globalStore.set(UsageReadingsAtom, {
                claude: reading("claude", 50, new Date(2026, 10, 15, 18, 0).getTime()),
            });
            blocks = blocksOf(render(), "claude");
            expect(blocks.map((b) => b.reset)).toEqual([false, false, false, false, false, false, true]);
            expect(blocks.map((b) => b.fill)).toEqual([100, 100, 50, 0, 0, 0, 100]);
            // A 30-day window that last reset on Saturday 31 October starts on Saturday, whatever week it is.
            globalStore.set(UsageReadingsAtom, {
                codex: {
                    agent: "codex",
                    source: "t",
                    readat: Date.now(),
                    windows: [
                        {
                            id: "window:43200",
                            label: "30-day",
                            usedpercent: 30,
                            resetsat: new Date(2026, 10, 30, 14, 0).getTime(),
                            windowmins: 43200,
                        },
                    ],
                },
            });
            blocks = blocksOf(render(), "codex");
            expect(blocks.map((b) => b.reset)).toEqual([false, false, false, false, false, true, false]);
            expect(blocks.map((b) => b.fill)).toEqual([10, 0, 0, 0, 0, 100, 100]);
        } finally {
            vi.useRealTimers();
        }
        const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8");
        expect(css).toMatch(/\.mt-uw-cell\.is-reset::after \{[^}]*animation: mt-uw-sheen/);
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
        expect(media).toMatch(/\.mt-uw-cell\.is-reset::after \{[^}]*animation: none/);
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-uw-cell\.is-reset::after \{[^}]*animation: none/);
    });

    it("keeps the reset ring on a full block, and both marks when the reset day is today", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            // Friday 13 November 2026: Claude resets tonight, Codex is full and resets on Saturday.
            vi.setSystemTime(new Date(2026, 10, 13, 12, 0));
            globalStore.set(UsageReadingsAtom, {
                claude: reading("claude", 2, new Date(2026, 10, 13, 20, 0).getTime()),
                codex: reading("codex", 100, new Date(2026, 10, 14, 7, 0).getTime()),
            });
            const html = render();
            const tags = (provider: string) => {
                const start = html.indexOf(cellTag(html, provider));
                const rowHtml = html.slice(start, html.indexOf("usage-week-percent", start));
                return [...rowHtml.matchAll(/<span [^>]*data-testid="usage-week-block"[^>]*>/g)].map((m) => m[0]);
            };
            expect(tags("claude")[4]).toContain('data-today="true"');
            expect(tags("claude")[4]).toContain('data-reset="true"');
            expect(tags("claude")[4]).toContain("is-today is-reset");
            expect(tags("codex")[5]).toContain('data-reset="true"');
            expect(blocksOf(html, "codex")[5]).toEqual({ fill: 100, reset: true });
        } finally {
            vi.useRealTimers();
        }
        const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        // A ring set away from the block reads the same empty or full; today's outline sits on the block itself.
        // Thin and close, as the slim grid of mockup version 13 (#2106); a block that clips paints no outline.
        expect(css).toMatch(
            /\.mt-uw-cell\.is-reset \{\s*overflow: visible;\s*outline: 1px solid var\(--mt-action\);\s*outline-offset: 1\.5px;/
        );
        expect(css).toMatch(/\.mt-uw-cell\.is-today \{[^}]*box-shadow: 0 0 0 1px/);
    });

    it("writes the initials in the interface language, Monday first, and follows a change without a restart", () => {
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 40) });
        const initials = () =>
            [...render().matchAll(/data-testid="usage-week-day"[^>]*>([^<]*)</g)].map((m) => m[1]).join("");
        const i18n = I18nModel.getInstance();
        try {
            globalStore.set(i18n.languageSettingAtom, "fr");
            expect(initials()).toBe("LMMJVSD");
            globalStore.set(i18n.languageSettingAtom, "en");
            expect(initials()).toBe("MTWTFSS");
        } finally {
            globalStore.set(i18n.languageSettingAtom, "");
        }
    });

    it("makes today's column stand out on every row", () => {
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 40), codex: reading("codex", 20) });
        const html = render();
        const today = (new Date().getDay() + 6) % 7;
        const todayBlocks = [...html.matchAll(/<span [^>]*data-testid="usage-week-block"[^>]*>/g)]
            .map((m, i) => [i % 7, m[0].includes('data-today="true"')])
            .filter(([, on]) => on)
            .map(([i]) => i);
        expect(todayBlocks).toEqual([today, today]);
    });

    it("colours each row by its pace: on pace green, a little ahead orange, far ahead red", () => {
        // Two days before the reset of a week, 5/7 of it is gone: 71 % allowed.
        globalStore.set(UsageReadingsAtom, {
            claude: reading("claude", 62),
            codex: reading("codex", 78),
            gemini: reading("gemini", 100),
        });
        const html = render();
        expect(cellTag(html, "claude")).toContain('data-pace="ok"');
        expect(cellTag(html, "claude")).toContain("--mt-uw-pace:var(--color-success)");
        expect(cellTag(html, "codex")).toContain('data-pace="above"');
        expect(cellTag(html, "codex")).toMatch(/--mt-uw-pace:color-mix\(in srgb, var\(--color-warning\) \d+%/);
        expect(cellTag(html, "gemini")).toContain('data-pace="above"');
        const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        expect(css).toMatch(/\.mt-uw-cell i \{[^}]*background: var\(--mt-uw-pace/);
        expect(css).toMatch(/\.mt-uw-pct \{[^}]*color: var\(--mt-uw-pace/);
    });

    it("gives Codex's 30-day window a row", () => {
        globalStore.set(UsageReadingsAtom, {
            codex: {
                agent: "codex",
                source: "t",
                readat: Date.now(),
                windows: [
                    {
                        id: "window:43200",
                        label: "30-day",
                        usedpercent: 47,
                        resetsat: Date.now() + 29 * 24 * 60 * Min,
                        windowmins: 43200,
                    },
                ],
            },
        });
        const html = render();
        expect(cellTag(html, "codex")).toContain('data-pace="red"');
        expect(cellTag(html, "codex")).toContain("--mt-uw-pace:var(--color-error)");
        expect(html).toMatch(/data-testid="usage-week-percent">47 %</);
    });

    // #2074: a day-old reading of a running week still shows, with its age; one that cannot be read says so calmly.
    it("marks an old reading with its age, and says when a provider cannot be read", () => {
        globalStore.set(UsageReadingsAtom, { codex: { ...reading("codex", 9), readat: Date.now() - 26 * 60 * Min } });
        let html = render();
        expect(cellTag(html, "codex")).toContain('data-old="true"');
        expect(cellTag(html, "codex")).toMatch(/aria-label="Codex, 9 %, resets [A-Za-z]+, read [^"]+"/);
        expect(html).toMatch(/data-testid="usage-week-percent">9 %</);
        globalStore.set(UsageReadingsAtom, { codex: reading("codex", 9) });
        expect(cellTag(render(), "codex")).not.toContain("data-old");
        globalStore.set(UsageReadingsAtom, {});
        globalStore.set(UsageUnreadableAtom, { codex: "expired" });
        html = render();
        expect(html).not.toContain('data-testid="brokk-usage-empty"');
        expect(html).toMatch(/data-testid="usage-week-unreadable">no reading</);
        expect(html).not.toContain('data-testid="usage-week-block"');
        globalStore.set(UsageUnreadableAtom, {});
    });

    it("says in one line when no provider shares a reading", () => {
        expect(render()).toContain('data-testid="brokk-usage-empty"');
    });

    // AC58 (#2106): the Usage panel repeated the grid; a later dedicated panel (#1893) will take the click.
    it("opens nothing on a click on the usage block: no control, no pressed state, no Usage panel", () => {
        globalStore.set(UsageReadingsAtom, { claude: reading("claude", 40), codex: reading("codex", 20) });
        const html = render();
        const tag = /<[a-z]+ [^>]*data-testid="brokk-usage"[^>]*>/.exec(html)[0];
        expect(tag.startsWith("<div ")).toBe(true);
        expect(tag).not.toMatch(/aria-pressed|aria-label|tabindex|role=/);
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).not.toContain('clickIcon("usage")');
        expect(source).not.toContain("UsagePanel");
        expect(attr(html, "brokk-panel", "data-panel")).toBe("notifications");
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        expect(css).not.toMatch(/\.mt-brokk-usage\[aria-pressed|\.mt-brokk-usage:focus-visible/);
    });

    // AC57 (#2106): the card follows the grid's measured height, so no row is drawn under the field.
    it("measures the usage grid and lays the card and the field out from it", () => {
        const source = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(source).toContain("const measure = () => setUsageHeight(usage.offsetHeight);");
        expect(source).toContain("observer.observe(usage);");
        expect(source).toContain("groupGeometry(SquarePx, TilePx, usageHeight)");
        expect(source).toContain('<div ref={usageRef} className="mt-brokk-usage" data-testid="brokk-usage">');
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
        expect(html.match(/data-testid="usage-week-row"/g)).toHaveLength(1);
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
        expect(source).toContain("globalStore.set(boss.talkingAtom, pose != null);");
    });
});

describe("the scrim over the work area (AC39, #2082)", () => {
    const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    it("shows only while the group is open, and fades out while it leaves", () => {
        expect(attr(render(Frame, true), "brokk-scrim", "class")).toBe("mt-brokk-scrim is-in");
        expect(attr(render(Frame, false), "brokk-scrim", "class")).toBe("mt-brokk-scrim");
        const rest = /\n\.mt-brokk-scrim \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(rest).toMatch(/inset: 0;/);
        expect(rest).toMatch(/opacity: 0;/);
        expect(rest).toMatch(/pointer-events: none;/);
        expect(rest).toMatch(/transition: opacity var\(--mt-duration-show\) linear;/);
        expect(rest).toMatch(/background: color-mix\(in srgb, var\(--mt-scrim\) 45%, transparent\);/);
        expect(css).not.toMatch(/\.mt-brokk-scrim[^{]*\{[^}]*(backdrop-filter|filter: blur)/);
        const shown = /\n\.mt-brokk-scrim\.is-in \{([^}]*)\}/.exec(css)?.[1] ?? "";
        expect(shown).toMatch(/opacity: 1;/);
        expect(shown).toMatch(/pointer-events: auto;/);
    });

    it("closes the group on a click", () => {
        const onClose = vi.fn();
        const el = BrokkScrim({ shown: true, onClose });
        el.props.onClick();
        expect(onClose).toHaveBeenCalledTimes(1);
        // The group's own outside-press listener closes on a press on it too: the scrim is not part of the group.
        expect(render(Frame, true)).toMatch(/data-testid="brokk-scrim"[^>]*>[\s\S]*data-testid="boss-card"/);
    });

    it("takes the short fade under reduced motion, in both ways the app tells it", () => {
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
        expect(media).toMatch(/\.mt-brokk-scrim \{\s*transition: opacity var\(--mt-duration-fade\) linear;/);
        expect(css).toMatch(
            /\.prefers-reduced-motion \.mt-brokk-scrim \{\s*transition: opacity var\(--mt-duration-fade\) linear;/
        );
    });
});
