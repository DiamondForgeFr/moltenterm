// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/contextmenu", () => ({ ContextMenuModel: { getInstance: () => ({ showContextMenu: vi.fn() }) } }));
vi.mock("../settings/settings-open", () => ({ openSettingsSection: vi.fn() }));
vi.mock("./brokk-menu", () => ({ brokkMenuItems: () => [] }));
vi.mock("../working-beat", () => ({ useWorkingBeat: vi.fn() }));
vi.mock("../downloads/downloads-store", async () => {
    const { atom } = await import("jotai");
    const model = { ringAtom: atom<unknown[]>([]) };
    return { DownloadsModel: { getInstance: () => model } };
});
vi.mock("./boss-portrait", () => ({
    BossPortrait: ({ live }: { live?: unknown }) => <span data-testid="portrait" data-live={live ? "true" : "false"} />,
}));

const Mocks = vi.hoisted(() => ({ hub: null as any, motion: true, models: null as any }));
vi.mock("./use-brokk-live", () => ({ useMotionAllowed: () => Mocks.motion }));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        nameAtom: atom("Brokk"),
        showAtom: atom(true),
        cardOpenAtom: atom(false),
        cardPinnedAtom: atom(false),
        talkingAtom: atom(false),
        keepAwakeAtom: atom(false),
        toHandleAtom: atom({ items: [], info: [], parked: 0 }),
        closeCard: vi.fn(),
        pinCard: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
vi.mock("./brokk-hub-store", async () => {
    const { atom } = await import("jotai");
    const { DefaultVisitSettings } = await import("./brokk-visit-events");
    const model = {
        ownWorkingAtom: atom(false),
        settingsAtom: atom(DefaultVisitSettings),
        sidebarPlaceAtom: atom("screen"),
        faceHover: { enterFace: vi.fn(), leaveFace: vi.fn(), cancel: vi.fn() },
        get hub() {
            return Mocks.hub;
        },
    };
    return { BrokkHubModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { DownloadsModel } from "../downloads/downloads-store";
import { BossBubbleModel } from "./boss-store";
import type { ToHandleItem } from "./boss-to-handle-model";
import { restingPose } from "./brokk-ask-model";
import { BrokkAvatar, BrokkAvatarSlot } from "./brokk-avatar";
import {
    AvatarPoses,
    avatarSituation,
    AvatarSizePx,
    downloadRingRadiusUnits,
    HangingSizePx,
    RingStrokeUnits,
    RingUnits,
    workingRingBoxPx,
} from "./brokk-avatar-model";
import { EdgeFacePx, EdgePx } from "./brokk-edge-model";
import { BrokkEdgeModel } from "./brokk-edge-store";
import { BrokkHub, HubDeps } from "./brokk-hub";
import { BrokkHubModel } from "./brokk-hub-store";
import { DefaultVisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";
import { useBrokkEdge } from "./use-brokk-edge";
import { useAvatarLive } from "./use-brokk-hub";

const boss = BossBubbleModel.getInstance() as any;
const hubModel = BrokkHubModel.getInstance() as any;

const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;

function row(key: string, tone: ToHandleItem["tone"] = "waiting", extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone,
        notice: null,
        lineFromNotice: false,
        name: key,
        line: { text: key },
        place: "",
        since: 0,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    };
}

function makeHub(): BrokkHub {
    const deps: HubDeps = {
        now: () => T,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => false,
        openPanel: () => {},
        readShared: () => EmptyShared,
        writeShared: () => {},
    };
    return new BrokkHub(deps);
}

// A row that waits on the developer for longer than the threshold: it brings a visit.
const BlockedRow = () => row("agent:a", "waiting", { since: T - 6 * Min });

function render(variant: "row" | "edge" | "hanging" = "row"): string {
    return renderToStaticMarkup(<BrokkAvatar variant={variant} />);
}

// The tests run in a plain Node environment, which has no DOM parser: read the markup with patterns.
function attr(html: string, testId: string, name: string): string {
    const tag = new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
    return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

// A stylesheet without its comments, which explain the rules in words the patterns below would catch.
function css(file: string): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function rule(sheet: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(sheet)?.[1] ?? "";
}

// The rows To handle, as the host feeds them to the hub and as the badge reads them.
function setRows(...items: ToHandleItem[]) {
    globalStore.set(boss.toHandleAtom, { items, info: [], parked: 0 });
    Mocks.hub.syncRows(items);
}

// Runs a hook in a component and hands back what it returned.
function hook<T>(use: () => T): T {
    let value: T;
    function Probe() {
        value = use();
        return null;
    }
    renderToStaticMarkup(<Probe />);
    return value;
}

beforeEach(() => {
    Mocks.motion = true;
    Mocks.hub = makeHub();
    globalStore.set(boss.nameAtom, "Brokk");
    globalStore.set(boss.showAtom, true);
    globalStore.set(boss.cardOpenAtom, false);
    globalStore.set(boss.cardPinnedAtom, false);
    globalStore.set(boss.talkingAtom, false);
    globalStore.set(boss.keepAwakeAtom, false);
    globalStore.set(hubModel.ownWorkingAtom, false);
    globalStore.set(hubModel.sidebarPlaceAtom, "screen");
    BrokkEdgeModel.getInstance().reset();
    setRows();
});

describe("the avatar at rest (FR-BOSS-009, AC1)", () => {
    it("is a round button of 26 px, named with his name and the count, that opens a dialog", () => {
        setRows(row("question:a"), row("question:b"));
        const html = render();
        expect(html).toMatch(/^<button[^>]*type="button"/);
        expect(attr(html, "brokk-avatar", "aria-label")).toBe("Brokk, 2 waiting");
        expect(attr(html, "brokk-avatar", "aria-haspopup")).toBe("dialog");
        expect(attr(html, "brokk-avatar", "aria-expanded")).toBe("false");
        expect(AvatarSizePx).toBe(26);
        const sheet = css("brokk-avatar.css");
        expect(rule(sheet, ".mt-brokk-avatar")).toContain("--mt-brokk-size: 26px");
        expect(rule(sheet, ".mt-brokk-avatar")).toMatch(/border-radius: 50%/);
    });

    it("uses the name the developer chose", () => {
        globalStore.set(boss.nameAtom, "Léa");
        // Nothing waits: no count of zero is read (#2155).
        expect(attr(render(), "brokk-avatar", "aria-label")).toBe("Léa");
    });

    it("carries his portrait, still when motion is reduced and calm and alive otherwise", () => {
        expect(render()).toContain('data-testid="portrait" data-live="true"');
        Mocks.motion = false;
        expect(render()).toContain('data-testid="portrait" data-live="false"');
    });

    it("stands in the layer of the card, as its anchor, so that a press on it is the toggle's", () => {
        expect(render()).toMatch(/data-testid="brokk-avatar"[^>]*data-boss-anchor=""/);
        expect(globalStore.get(boss.cardOpenAtom)).toBe(false);
    });

    it("says its group is open and keeps its face, as a still frame while the square plays the animated one (#2032)", () => {
        globalStore.set(boss.cardOpenAtom, true);
        const html = render();
        expect(attr(html, "brokk-avatar", "aria-expanded")).toBe("true");
        expect(attr(html, "brokk-avatar", "data-panel")).toBe("open");
        expect(html).toContain('data-live="false"');
        expect(html.match(/data-testid="portrait"/g)).toHaveLength(1);
        // The face stays: the title-bar face is still the face of Brokk while his group shows.
        expect(rule(css("brokk-avatar.css"), '.mt-brokk-avatar[data-panel="open"] .mt-brokk-face')).toBe("");
    });

    it("names its click for what it does while the group is open and pinned: it closes it", () => {
        globalStore.set(boss.cardOpenAtom, true);
        globalStore.set(boss.cardPinnedAtom, true);
        expect(attr(render(), "brokk-avatar", "aria-label")).toBe("Close Brokk");
        expect(attr(render(), "brokk-avatar", "data-pinned")).toBe("true");
        globalStore.set(boss.nameAtom, "Léa");
        expect(attr(render(), "brokk-avatar", "aria-label")).toBe("Close Léa");
        expect(attr(render(), "brokk-avatar", "title")).toBeUndefined();
    });

    it("does not name its click Close while the hover opened the group: the click pins it (#2103, AC55)", () => {
        globalStore.set(boss.cardOpenAtom, true);
        globalStore.set(boss.cardPinnedAtom, false);
        const html = render();
        expect(attr(html, "brokk-avatar", "aria-label")).toBe("Brokk");
        expect(attr(html, "brokk-avatar", "aria-expanded")).toBe("true");
        expect(attr(html, "brokk-avatar", "data-pinned")).toBeUndefined();
    });

    it("keeps its badge while the group is open", () => {
        setRows(row("question:a"));
        globalStore.set(boss.cardOpenAtom, true);
        expect(render()).toContain('data-testid="boss-badge"');
    });

    it("shows the sign of a conversation only while the developer writes to him or his session answers, not merely while the group is open", () => {
        globalStore.set(boss.cardOpenAtom, true);
        expect(render()).not.toContain('data-testid="brokk-talking"');
        globalStore.set(boss.talkingAtom, true);
        expect(render()).toContain('data-testid="brokk-talking"');
        globalStore.set(boss.cardOpenAtom, false);
        expect(render()).not.toContain('data-testid="brokk-talking"');
    });

    it("shows the cup while keep-awake holds this computer awake and he is closed (#2032)", () => {
        expect(render()).not.toContain('data-testid="brokk-cup"');
        globalStore.set(boss.keepAwakeAtom, true);
        expect(render()).toContain('data-testid="brokk-cup"');
        globalStore.set(boss.cardOpenAtom, true);
        expect(render()).not.toContain('data-testid="brokk-cup"');
        expect(rule(css("brokk-avatar.css"), ".mt-brokk-avatar.is-hanging .mt-brokk-cup")).toMatch(/display: none/);
    });

    it("shows no tooltip of its own and no title at rest", () => {
        expect(attr(render(), "brokk-avatar", "title")).toBeUndefined();
    });

    it("draws the open sign as a soft ring in the action colour, with no motion, and the conversation sign with none either", () => {
        const sheet = css("brokk-avatar.css");
        const open = rule(sheet, '.mt-brokk-avatar[data-panel="open"]');
        expect(open).toMatch(/box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--mt-action\)/);
        expect(open).not.toMatch(/animation|transition/);
        expect(rule(sheet, ".mt-brokk-talk")).toMatch(/color: var\(--mt-action\)/);
        expect(rule(sheet, ".mt-brokk-talk")).not.toMatch(/animation/);
        expect(rule(sheet, ".mt-brokk-avatar.is-hanging .mt-brokk-talk")).toMatch(/display: none/);
    });

    it("hangs from the window's top edge, smaller, when the sidebar is not on screen", () => {
        const html = render("hanging");
        expect(html).toContain("is-hanging");
        expect(attr(html, "brokk-avatar", "data-brokk-avatar")).toBe("hanging");
        expect(HangingSizePx).toBe(14);
        const hanging = rule(css("brokk-avatar.css"), ".mt-brokk-avatar.is-hanging");
        expect(hanging).toContain(`--mt-brokk-size: ${HangingSizePx}px`);
        // From the window's edge down to the pennant's footprint: the panels' controls start 15 px below it.
        expect(hanging).toMatch(/top: 0;/);
        expect(HangingSizePx).toBeLessThanOrEqual(8 + 7);
        expect(rule(css("brokk-avatar.css"), ".mt-brokk-avatar.is-hanging .mt-brokk-badge")).toMatch(/left: -\d+px/);
    });
});

describe("the badge (AC1)", () => {
    it("is hidden at zero", () => {
        expect(render()).not.toContain('data-testid="boss-badge"');
    });

    it("counts what waits, amber, and red when a counted row failed, 9+ beyond nine", () => {
        setRows(row("question:a"));
        const one = render();
        expect(one).toMatch(/data-testid="boss-badge"[^>]*>1</);
        expect(one).toMatch(/data-tone="waiting"[^>]*data-testid="boss-badge"/);
        setRows(row("question:a"), row("agent:b", "error"));
        expect(render()).toMatch(/data-tone="error"[^>]*data-testid="boss-badge"[^>]*>2</);
        setRows(...Array.from({ length: 12 }, (_, i) => row(`question:${i}`)));
        expect(render()).toMatch(/data-testid="boss-badge"[^>]*>9\+</);
    });

    it("counts the events the model counts, and not the ones the developer set to Rien", () => {
        setRows(row("agent:a", "error"));
        expect(attr(render(), "brokk-avatar", "aria-label")).toBe("Brokk, 1 waiting");
        const rien = { ...DefaultVisitSettings, coming: { ...DefaultVisitSettings.coming, error: "rien" as const } };
        globalStore.set(hubModel.settingsAtom, rien);
        Mocks.hub.settings(rien);
        expect(render()).not.toContain('data-testid="boss-badge"');
    });
});

describe("the ring (AC2)", () => {
    it("shows only while Brokk himself works", () => {
        expect(render()).not.toContain('data-testid="brokk-ring"');
        expect(attr(render(), "brokk-avatar", "data-working")).toBeUndefined();
        globalStore.set(hubModel.ownWorkingAtom, true);
        expect(render()).toContain('data-testid="brokk-ring"');
        expect(attr(render(), "brokk-avatar", "data-working")).toBe("true");
    });

    it("never turns because other agents work: the avatar reads none of their states", () => {
        const source = readFileSync(join(__dirname, "brokk-avatar.tsx"), "utf8");
        expect(source).not.toMatch(/workingCountAtom|AgentStates|agent-state/);
        const hubSource = readFileSync(join(__dirname, "use-brokk-hub.ts"), "utf8");
        expect(hubSource).not.toMatch(/workingCountAtom|AgentStates|agent-state/);
    });

    it("is the bell's ring on the working beat, and has no motion of its own that reduced motion could not still", () => {
        globalStore.set(hubModel.ownWorkingAtom, true);
        expect(render()).toMatch(/<svg[^>]*class="mt-brokk-ring mt-beat-turn"/);
        const sheet = css("brokk-avatar.css");
        expect(sheet).not.toMatch(/animation|@keyframes|infinite/);
    });

    it("thinks only while his own session works", () => {
        const probe = (own: boolean, replaced: boolean = false) => hook(() => useAvatarLive(own, replaced)) as any;
        expect(probe(false)).toMatchObject({ rhythm: "calm", situation: { working: 0, waiting: 0 } });
        expect(probe(true).situation.working).toBe(1);
        expect(probe(false, true)).toBeNull();
        Mocks.motion = false;
        expect(probe(false)).toBeNull();
    });

    it("declares only the poses it can take, so that the portrait mounts the transitions between them (#2154)", () => {
        const live = hook(() => useAvatarLive(false, false)) as any;
        expect(live.poses).toBe(AvatarPoses);
        expect(AvatarPoses).toEqual(["listening", "thinking"]);
        const taken = [false, true].map((own) => restingPose(avatarSituation(own)));
        expect(taken.every((pose) => AvatarPoses.includes(pose))).toBe(true);
    });
});

describe("the soft cue while he waits for the gate (AC8)", () => {
    it("carries a halo and says so while a visit waits on the pointer", () => {
        Mocks.hub.gate({ type: "enter" });
        Mocks.hub.syncRows([BlockedRow()]);
        const html = render();
        expect(attr(html, "brokk-avatar", "data-cue")).toBe("true");
        expect(html).toContain('data-testid="brokk-halo"');
        expect(html).toContain('class="mt-brokk-halo mt-beat-blink"');
        expect(attr(html, "brokk-avatar", "aria-label")).toContain("has something to tell you");
    });

    it("has none when nothing waits, and none once the scene is up", () => {
        expect(render()).not.toContain("brokk-halo");
        Mocks.hub.syncRows([BlockedRow()]);
        const html = render();
        expect(html).not.toContain("brokk-halo");
        expect(attr(html, "brokk-avatar", "data-scene")).toBe("up");
    });

    it("is a steady halo that dims on the working beat, and stills with it", () => {
        const sheet = css("brokk-avatar.css");
        expect(rule(sheet, ".mt-brokk-halo")).toMatch(/box-shadow/);
        expect(sheet).not.toMatch(/animation/);
    });
});

describe("the scene stands in his place", () => {
    it("hides the avatar from sight, from the pointer and from the keyboard while the scene is up", () => {
        const sheet = css("brokk-avatar.css");
        const hidden = rule(sheet, '.mt-brokk-avatar[data-scene="up"]');
        expect(hidden).toMatch(/opacity: 0/);
        expect(hidden).toMatch(/visibility: hidden/);
        expect(hidden).toMatch(/pointer-events: none/);
    });

    it("stops its portrait while the scene is up", () => {
        Mocks.hub.syncRows([BlockedRow()]);
        expect(render()).toContain('data-live="false"');
    });
});

describe("the avatar of the sidebar's row (AC1, AC14)", () => {
    it("is there while the sidebar is on screen", () => {
        const html = renderToStaticMarkup(<BrokkAvatarSlot />);
        expect(html).toContain('data-brokk-avatar="row"');
    });

    it("is not there with no sidebar: the one that hangs from the window's edge stands in", () => {
        globalStore.set(hubModel.sidebarPlaceAtom, "none");
        expect(renderToStaticMarkup(<BrokkAvatarSlot />)).toBe("");
    });

    it("stays on the strip of a collapsed sidebar instead of hanging from the window's top right (#2070, AC27)", () => {
        globalStore.set(hubModel.sidebarPlaceAtom, "edge");
        const html = renderToStaticMarkup(<BrokkAvatarSlot />);
        expect(html).toContain('data-brokk-avatar="edge"');
        expect(html).toContain("is-edge");
        expect(html).not.toContain("is-hanging");
    });

    it("is not there when Settings turned Brokk off", () => {
        globalStore.set(boss.showAtom, false);
        expect(renderToStaticMarkup(<BrokkAvatarSlot />)).toBe("");
    });
});

describe("on the strip of the collapsed sidebar (FR-BOSS-009, AC27, AC28, #2070)", () => {
    it("is the same avatar with its badge, smaller, and not the one that hangs from the window's top right", () => {
        setRows(row("question:a"), row("question:b"));
        const html = render("edge");
        expect(attr(html, "brokk-avatar", "data-brokk-avatar")).toBe("edge");
        expect(attr(html, "brokk-avatar", "class")).toContain("is-edge");
        expect(attr(html, "brokk-avatar", "class")).not.toContain("is-hanging");
        expect(attr(html, "brokk-avatar", "aria-label")).toBe("Brokk, 2 waiting");
        expect(html).toContain('data-testid="boss-badge"');
    });

    it("keeps its click: it opens his group, as in the title row", () => {
        expect(attr(render("edge"), "brokk-avatar", "aria-haspopup")).toBe("dialog");
    });

    it("outlines the face for a notification the developer has not seen, with reduced motion only", () => {
        const edge = BrokkEdgeModel.getInstance();
        edge.tell([], false, true);
        edge.tell([], false, true);
        edge.tell(["agent:a"], false, true);
        Mocks.motion = false;
        expect(attr(render("edge"), "brokk-avatar", "data-news")).toBe("true");
        Mocks.motion = true;
        expect(attr(render("edge"), "brokk-avatar", "data-news")).toBeUndefined();
    });

    it("outlines nothing once the developer has looked, and nothing off the strip", () => {
        const edge = BrokkEdgeModel.getInstance();
        edge.tell([], false, true);
        edge.tell([], false, true);
        edge.tell(["agent:a"], false, true);
        Mocks.motion = false;
        expect(attr(render("row"), "brokk-avatar", "data-news")).toBeUndefined();
        expect(attr(render("hanging"), "brokk-avatar", "data-news")).toBeUndefined();
        edge.tell(["agent:a"], true, true);
        expect(attr(render("edge"), "brokk-avatar", "data-news")).toBeUndefined();
    });
});

describe("how the sidebar stands for him (#2070, AC27, AC29)", () => {
    const shape = () => hook(() => useBrokkEdge({ current: null })).shape;

    it("rests on its strip when it is collapsed and nothing waits", () => {
        globalStore.set(hubModel.sidebarPlaceAtom, "edge");
        expect(shape()).toBe("rest");
    });

    it("stays half open while something important is due, and rests again once it is handled", () => {
        globalStore.set(hubModel.sidebarPlaceAtom, "edge");
        Mocks.hub.gate({ type: "hidden", hidden: true });
        Mocks.hub.gate({ type: "edge", edge: true });
        setRows(BlockedRow());
        expect(shape()).toBe("ajar");
        setRows();
        expect(shape()).toBe("rest");
    });

    it("has no shape when the sidebar is on screen or absent", () => {
        globalStore.set(hubModel.sidebarPlaceAtom, "screen");
        expect(shape()).toBeNull();
        globalStore.set(hubModel.sidebarPlaceAtom, "none");
        expect(shape()).toBeNull();
    });
});

describe("no hover card: hovering the face opens his group (FR-BOSS-009, AC52 to AC55, #2103)", () => {
    const source = () => readFileSync(join(__dirname, "brokk-avatar.tsx"), "utf8");

    it("renders no tooltip or summary card, and the card's module and style are gone", () => {
        globalStore.set(boss.cardOpenAtom, false);
        const html = render();
        expect(html).not.toContain('role="tooltip"');
        expect(html).not.toContain("boss-peek");
        expect(attr(html, "brokk-avatar", "aria-describedby")).toBeUndefined();
        expect(existsSync(join(__dirname, "brokk-peek.tsx"))).toBe(false);
        expect(css("brokk-avatar.css")).not.toContain("mt-brokk-tooltip");
        expect(source()).not.toMatch(/BrokkTooltip|PeekDelayMs/);
    });

    it("tells the face's hover when the pointer arrives and leaves, with a held button as no hover", () => {
        expect(source()).toContain("hover.enterFace(e.buttons !== 0)");
        expect(source()).toContain("onPointerLeave={() => hover.leaveFace()}");
    });

    it("decides its click by faceClickAction: a hover-opened group is pinned, only a pinned one closes", () => {
        expect(source()).toContain("faceClickAction(cardOpen, pinned)");
        expect(source()).toMatch(/action === "pin"\) \{\s*boss\.pinCard\(\);/);
    });
});

describe("the download ring on his face (FR-BOSS-009, AC34 to AC36, #2083)", () => {
    const Length = 2 * Math.PI * downloadRingRadiusUnits("row");
    const runningAtom = (DownloadsModel.getInstance() as any).ringAtom;
    const running = (...items: { received: number; total: number; state?: string }[]) =>
        globalStore.set(
            runningAtom,
            items.map((item, i) => ({ id: `d${i}`, state: item.state ?? "progressing", ...item }))
        );
    const dash = (html: string) => parseFloat(/stroke-dasharray="([\d.]+)/.exec(html)?.[1] ?? "NaN");
    // The first circle of a ring's svg: its radius and stroke, in the ring's own units.
    const ringCircle = (html: string, testId: string) => {
        const svg = new RegExp(`<svg[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</svg>`).exec(html)?.[1] ?? "";
        const circle = /<circle[^>]*>/.exec(svg)?.[0] ?? "";
        return {
            r: parseFloat(/ r="([\d.]+)"/.exec(circle)?.[1] ?? "NaN"),
            stroke: parseFloat(/stroke-width="([\d.]+)"/.exec(circle)?.[1] ?? "NaN"),
        };
    };

    afterEach(() => running());

    it("shows no ring while no download runs", () => {
        expect(render()).not.toContain('data-testid="brokk-download-ring"');
    });

    it("shows a thin ring in the rail's ember at the overall progress of the running download, and names it", () => {
        running({ received: 13, total: 100 });
        const html = render();
        expect(html).toContain('data-testid="brokk-download-ring"');
        expect(dash(html)).toBeCloseTo(0.13 * Length, 3);
        expect(attr(html, "brokk-download-ring", "class")).toBe("mt-brokk-download");
        expect(attr(html, "brokk-avatar", "aria-label")).toContain("1 download running, 13 %");
    });

    it("shows the mean of the running downloads, with a count in its name", () => {
        running({ received: 25, total: 100 }, { received: 75, total: 100 });
        const html = render();
        expect(dash(html)).toBeCloseTo(0.5 * Length, 3);
        expect(attr(html, "brokk-avatar", "aria-label")).toContain("2 downloads running, 50 %");
    });

    it("is a quarter arc, with no percentage, while no running download knows its size", () => {
        running({ received: 10, total: 0 });
        const html = render();
        expect(dash(html)).toBeCloseTo(0.25 * Length, 3);
        const label = attr(html, "brokk-avatar", "aria-label");
        expect(label).toContain("1 download running");
        expect(label).not.toContain("%");
    });

    it("keeps the cup and the badge where they are, beside the ring", () => {
        globalStore.set(boss.keepAwakeAtom, true);
        setRows(row("question:a"));
        running({ received: 13, total: 100 });
        const html = render();
        expect(html).toContain('data-testid="brokk-download-ring"');
        expect(html).toContain('data-testid="brokk-cup"');
        expect(html).toMatch(/data-testid="boss-badge"[^>]*>1</);
    });

    it("draws both rings when he works and a download runs: the download is concentric with the working ring, 2 px outside it and as thick, in every variant", () => {
        globalStore.set(hubModel.ownWorkingAtom, true);
        running({ received: 13, total: 100 });
        for (const variant of ["row", "edge", "hanging"] as const) {
            const html = render(variant);
            expect(html).toContain('data-testid="brokk-ring"');
            expect(html).toContain('data-testid="brokk-download-ring"');
            const working = ringCircle(html, "brokk-ring");
            const download = ringCircle(html, "brokk-download-ring");
            const pxPerUnit = workingRingBoxPx(variant) / RingUnits;
            expect(download.stroke).toBe(working.stroke);
            expect(download.r - download.stroke / 2 - (working.r + working.stroke / 2)).toBeCloseTo(2 / pxPerUnit, 6);
        }
    });

    it("fits both rings inside the collapsed strip, the face centred in it, with no clipping at the window's edge (#2083)", () => {
        const outer = (radiusUnits: number) =>
            ((radiusUnits + RingStrokeUnits / 2) * workingRingBoxPx("edge")) / RingUnits;
        const half = EdgePx / 2;
        expect(outer(downloadRingRadiusUnits("edge"))).toBeLessThanOrEqual(half);
        expect(outer(13)).toBeLessThanOrEqual(half);
        expect(EdgeFacePx).toBeLessThan(EdgePx);
    });

    it("never turns: its rule has no animation and no transition, and it carries no working beat", () => {
        running({ received: 13, total: 100 });
        const html = render();
        expect(attr(html, "brokk-download-ring", "class")).not.toContain("mt-beat-turn");
        const sheet = rule(css("brokk-avatar.css"), ".mt-brokk-download");
        expect(sheet).not.toMatch(/animation|transition/);
    });
});

describe("the portrait (FR-BOSS-001, AC1)", () => {
    const jpg = join(__dirname, "portrait", "brokk", "brokk.jpg");

    it("is Brokk's validated still, a JPG of at most 1024 px and under 600 KB", () => {
        const bytes = readFileSync(jpg);
        expect(bytes.length).toBeLessThan(600_000);
        // The JPEG start-of-frame marker holds the pixel size: height, then width, big endian.
        let side = 0;
        for (let i = 2; i + 9 < bytes.length; ) {
            if (bytes[i] !== 0xff) {
                break;
            }
            const marker = bytes[i + 1];
            if (marker >= 0xc0 && marker <= 0xc3) {
                side = Math.max(bytes.readUInt16BE(i + 5), bytes.readUInt16BE(i + 7));
                break;
            }
            i += 2 + bytes.readUInt16BE(i + 2);
        }
        expect(side).toBeGreaterThan(0);
        expect(side).toBeLessThanOrEqual(1024);
    });

    it("is framed on his head in one place, which the avatar's face and the panel's face both use", () => {
        const framing = css("boss-portrait.css");
        expect(framing).toMatch(/--mt-boss-head-scale: [\d.]+;/);
        expect(framing).toMatch(/--mt-boss-head-origin: \d+% \d+%;/);
        // The numbers appear nowhere else.
        for (const file of ["brokk-avatar.css", "brokk-group.css", "brokk-visit-scene.css", "brokk-live.css"]) {
            expect(css(file)).not.toMatch(/--mt-boss-head-/);
        }
        expect(readFileSync(join(__dirname, "brokk-group.tsx"), "utf8")).toContain('from "./boss-portrait"');
        expect(readFileSync(join(__dirname, "brokk-avatar.tsx"), "utf8")).toContain('from "./boss-portrait"');
    });

    it("shows the whole face: the goggles to the top of the beard, the eyes well clear of the round's edge", () => {
        const framing = css("boss-portrait.css");
        const scale = Number(/--mt-boss-head-scale: ([\d.]+);/.exec(framing)[1]);
        const origin = Number(/--mt-boss-head-origin: \d+% (\d+)%;/.exec(framing)[1]);
        // Where the features sit on brokk.jpg, in % of its height, measured on the file.
        const Goggles = 12;
        const Eyes = 27;
        const TopOfBeard = 45;
        // The window the round shows: the origin keeps its place and the scale takes everything else in.
        const top = origin * (1 - 1 / scale);
        const span = 100 / scale;
        expect(scale).toBeGreaterThanOrEqual(2.2);
        expect(scale).toBeLessThanOrEqual(2.4);
        expect(top).toBeLessThanOrEqual(Goggles - 2);
        expect(top + span).toBeGreaterThanOrEqual(TopOfBeard + 5);
        // The eyes lie on the upper half of the round, where a circle is nearly as wide as the round.
        const eyes = (Eyes - top) / span;
        expect(eyes).toBeGreaterThan(0.25);
        expect(eyes).toBeLessThan(0.5);
        expect(2 * Math.sqrt(0.25 - (eyes - 0.5) ** 2)).toBeGreaterThan(0.95);
    });

    it("has a still frame with no motion of its own", () => {
        expect(css("boss-portrait.css")).not.toMatch(/animation|transition/);
    });
});

describe("what went away with the bubble (FR-BOSS-009, AC13)", () => {
    it("leaves no bubble, pennant or comm screen to mount", () => {
        for (const file of [
            "boss-bubble.tsx",
            "boss-bubble.css",
            "boss-screen.tsx",
            "boss-screen.css",
            "boss-place.ts",
        ]) {
            expect(() => readFileSync(join(__dirname, file)), file).toThrow();
        }
        const workspace = readFileSync(join(__dirname, "..", "..", "app", "workspace", "workspace.tsx"), "utf8");
        expect(workspace).toContain("<BrokkHubHost />");
        expect(workspace).not.toContain("BossBubbleHost");
    });

    it("keeps the settings: his name, and Show the avatar", () => {
        const store = readFileSync(join(__dirname, "boss-store.ts"), "utf8");
        expect(store).toContain("showAtom");
        expect(store).toContain("nameAtom");
    });
});
