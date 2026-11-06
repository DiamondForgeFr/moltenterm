// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/contextmenu", () => ({ ContextMenuModel: { getInstance: () => ({ showContextMenu: vi.fn() }) } }));
vi.mock("../settings/settings-open", () => ({ openSettingsSection: vi.fn() }));
vi.mock("../working-beat", () => ({ useWorkingBeat: vi.fn() }));
vi.mock("./brokk-peek", () => ({ BrokkTooltip: () => null }));
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
        toHandleAtom: atom({ items: [], info: [], parked: 0 }),
        closeCard: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
vi.mock("./brokk-hub-store", async () => {
    const { atom } = await import("jotai");
    const { DefaultVisitSettings } = await import("./brokk-visit-events");
    const model = {
        ownWorkingAtom: atom(false),
        settingsAtom: atom(DefaultVisitSettings),
        sidebarOnScreenAtom: atom(true),
        get hub() {
            return Mocks.hub;
        },
    };
    return { BrokkHubModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import type { ToHandleItem } from "./boss-to-handle-model";
import { BossBubbleModel } from "./boss-store";
import { BrokkAvatar, BrokkAvatarSlot } from "./brokk-avatar";
import { AvatarSizePx, HangingSizePx } from "./brokk-avatar-model";
import { BrokkHub, HubDeps } from "./brokk-hub";
import { BrokkHubModel } from "./brokk-hub-store";
import { DefaultVisitSettings } from "./brokk-visit-events";
import { EmptyShared } from "./brokk-visit-share";
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

function render(variant: "row" | "hanging" = "row"): string {
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
    globalStore.set(hubModel.ownWorkingAtom, false);
    globalStore.set(hubModel.sidebarOnScreenAtom, true);
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
        expect(attr(render(), "brokk-avatar", "aria-label")).toBe("Léa, 0 waiting");
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

    it("says its card is open, and empties its face while the card shows his", () => {
        globalStore.set(boss.cardOpenAtom, true);
        const html = render();
        expect(attr(html, "brokk-avatar", "aria-expanded")).toBe("true");
        expect(attr(html, "brokk-avatar", "data-panel")).toBe("open");
        expect(html).toContain('data-live="false"');
        expect(rule(css("brokk-avatar.css"), '.mt-brokk-avatar[data-panel="open"] .mt-brokk-face')).toMatch(/visibility: hidden/);
    });

    it("hangs from the window's top edge, smaller, when the sidebar is not on screen", () => {
        const html = render("hanging");
        expect(html).toContain("is-hanging");
        expect(attr(html, "brokk-avatar", "data-brokk-avatar")).toBe("hanging");
        expect(HangingSizePx).toBe(22);
        expect(rule(css("brokk-avatar.css"), ".mt-brokk-avatar.is-hanging")).toContain("--mt-brokk-size: 22px");
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

    it("is not there while the sidebar is off screen: the one that hangs from the window's edge stands in", () => {
        globalStore.set(hubModel.sidebarOnScreenAtom, false);
        expect(renderToStaticMarkup(<BrokkAvatarSlot />)).toBe("");
    });

    it("is not there when Settings turned Brokk off", () => {
        globalStore.set(boss.showAtom, false);
        expect(renderToStaticMarkup(<BrokkAvatarSlot />)).toBe("");
    });
});

describe("the tooltip (AC1)", () => {
    it("is read only, takes neither the pointer nor the focus, and stands above the panels and under the toasts", () => {
        const tooltip = rule(css("brokk-avatar.css"), ".mt-brokk-tooltip");
        expect(tooltip).toMatch(/pointer-events: none/);
        const z = Number(/z-index: (\d+)/.exec(tooltip)?.[1]);
        expect(z).toBeGreaterThan(800);
        expect(z).toBeLessThan(9400);
    });

    it("shows nothing until the pointer has stayed: the bubble's old delay", () => {
        expect(render()).not.toContain('role="tooltip"');
        expect(attr(render(), "brokk-avatar", "aria-describedby")).toBeUndefined();
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

    it("is framed on his head in one place, which the avatar's face and the card's face both use", () => {
        const framing = css("boss-portrait.css");
        expect(framing).toMatch(/--mt-boss-head-scale: [\d.]+;/);
        expect(framing).toMatch(/--mt-boss-head-origin: \d+% \d+%;/);
        // The numbers appear nowhere else.
        for (const file of ["brokk-avatar.css", "boss-card.css", "brokk-visit-scene.css", "brokk-live.css"]) {
            expect(css(file)).not.toMatch(/--mt-boss-head-/);
        }
        expect(readFileSync(join(__dirname, "boss-card.tsx"), "utf8")).toContain('from "./boss-portrait"');
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
        for (const file of ["boss-bubble.tsx", "boss-bubble.css", "boss-screen.tsx", "boss-screen.css", "boss-place.ts"]) {
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
