// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

const Mocks = vi.hoisted(() => ({ hub: null as any, motion: true, reduced: false }));
vi.mock("./brokk-hub-store", () => ({ BrokkHubModel: { getInstance: () => ({ hub: Mocks.hub }) } }));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const model = { nameAtom: atom("Brokk") };
    return { BossBubbleModel: { getInstance: () => model } };
});
vi.mock("./use-brokk-hub", () => ({ useHubSelect: (select: (view: unknown) => unknown) => select(Mocks.hub.getView()) }));
vi.mock("./use-brokk-live", () => ({ useMotionAllowed: () => Mocks.motion }));
vi.mock("../molten-motion", () => ({ prefersReducedMotion: () => Mocks.reduced }));

import { t } from "../i18n/i18n";
import { BrokkHub, HubDeps } from "./brokk-hub";
import { Severity } from "./brokk-queue";
import { EmptyShared } from "./brokk-visit-share";
import type { Visit } from "./brokk-visit";
import { BrokkVisitSceneView, LaterMenu } from "./brokk-visit-scene";
import {
    laterOptions,
    MotionTimings,
    sceneActions,
    SceneFadePx,
    SceneGapPx,
    sceneLabel,
    SceneRoomPx,
    sceneTimings,
} from "./brokk-visit-scene-model";

const Severities: Severity[] = ["grave", "important", "neutre", "bonne"];
const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;

function visit(severity: Severity): Visit {
    const expression = { grave: "frown", important: "doubtful", neutre: "call", bonne: "smile" }[severity];
    return { severity, expression: expression as Visit["expression"], keys: ["agent:a"], count: 1 };
}

function render(severity: Severity, shown: boolean = true): string {
    return renderToStaticMarkup(
        <BrokkVisitSceneView visit={visit(severity)} name="Brokk" shown={shown} rowHeight="38px" />
    );
}

// The tests run in a plain Node environment, which has no DOM parser: read the markup with patterns.
function attr(html: string, testId: string, name: string): string {
    const tag = new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
    return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

// A stylesheet without its comments, which explain the rules in words the patterns below would catch.
function css(file: string, folder: string = __dirname): string {
    return readFileSync(join(folder, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

// The declarations of the rule whose selector is exactly `selector`.
function rule(sheet: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(sheet);
    return match?.[1] ?? "";
}

function hubFixture(): { hub: BrokkHub; panels: () => number } {
    let panels = 0;
    const deps: HubDeps = {
        now: () => T,
        setTimer: () => 0,
        clearTimer: () => {},
        overlayOpen: () => false,
        openPanel: () => {
            panels++;
        },
        readShared: () => EmptyShared,
        writeShared: () => {},
    };
    return { hub: new BrokkHub(deps), panels: () => panels };
}

beforeEach(() => {
    Mocks.motion = true;
    Mocks.reduced = false;
    Mocks.hub = hubFixture().hub;
});

describe("the forge scene (FR-BOSS-009, AC6)", () => {
    it("has no text of its own but Plus tard: his face is all it says", () => {
        for (const severity of Severities) {
            const text = render(severity)
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            expect(text, severity).toBe(t("boss.visit.later.label"));
        }
    });

    it("is named for the severity, and says the same as a tooltip", () => {
        for (const severity of Severities) {
            const html = render(severity);
            const label = sceneLabel(t, "Brokk", severity);
            expect(attr(html, "brokk-scene-hit", "aria-label")).toBe(label);
            expect(attr(html, "brokk-scene-hit", "title")).toBe(label);
        }
        expect(sceneLabel(t, "Brokk", "grave")).toContain("Brokk");
        expect(sceneLabel(t, "Brokk", "grave")).toContain(t("boss.visit.severity.grave"));
    });

    it("makes the face of the severity with the clip of that face", () => {
        expect(attr(render("grave"), "brokk-scene-video", "src")).toContain("listening.frown");
        expect(attr(render("important"), "brokk-scene-video", "src")).toContain("listening.doubtful");
        expect(attr(render("neutre"), "brokk-scene-video", "src")).toContain("listening.call");
        expect(attr(render("bonne"), "brokk-scene-video", "src")).toContain("listening.smile");
    });

    it("plays his clip in a loop only when motion is allowed, and holds one still frame of it otherwise", () => {
        const html = render("important");
        expect(html).toContain("<video");
        expect(html).toMatch(/autoPlay=""|autoplay=""/i);
        expect(html).toMatch(/loop=""/);
        expect(html).toMatch(/muted=""/);
        Mocks.motion = false;
        expect(render("important")).not.toMatch(/autoPlay=""|autoplay=""/i);
    });

    it("is one button over the whole scene, named, that the keyboard reaches only once it is shown", () => {
        const shown = render("important", true);
        expect(shown).toMatch(/<button[^>]*data-testid="brokk-scene-hit"/);
        expect(attr(shown, "brokk-scene-hit", "tabindex")).toBe("0");
        expect(attr(shown, "brokk-scene", "data-open")).toBe("true");
        const folding = render("important", false);
        expect(attr(folding, "brokk-scene-hit", "tabindex")).toBe("-1");
        expect(attr(folding, "brokk-scene", "data-open")).toBe("false");
    });

    it("carries the severity for its glow, never a colour of alarm", () => {
        expect(attr(render("grave"), "brokk-scene", "data-severity")).toBe("grave");
        const sheet = css("brokk-visit-scene.css");
        expect(sheet).not.toMatch(/\bred\b|#f00|#ff0000|rgb\(2[0-5]\d, ?0, ?0\)/i);
    });

    it("offers Plus tard at the bottom left, and the delays only once it is chosen", () => {
        const html = render("important");
        expect(html).toContain('data-testid="brokk-later"');
        expect(html).not.toContain('data-testid="brokk-later-menu"');
        const later = rule(css("brokk-visit-scene.css"), ".mt-brokk-later");
        expect(later).toMatch(/left: \d+px/);
        expect(later).toMatch(/bottom: \d+px/);
    });
});

describe("the Plus tard menu per severity (AC7)", () => {
    function menu(severity: Severity): string {
        return renderToStaticMarkup(<LaterMenu options={laterOptions(severity, T)} onChoose={() => {}} />);
    }
    const choices = (html: string) => [...html.matchAll(/data-choice="([^"]+)"/g)].map((m) => m[1]);

    it("offers 5 min, 15 min and 1 h for a grave visit", () => {
        expect(choices(menu("grave"))).toEqual(["5min", "15min", "1h"]);
    });

    it("offers 15 min, 1 h and this evening for an important one", () => {
        expect(choices(menu("important"))).toEqual(["15min", "1h", "tonight"]);
    });

    it("offers 1 h, this evening and tomorrow morning for a neutre one and for good news", () => {
        expect(choices(menu("neutre"))).toEqual(["1h", "tonight", "tomorrow"]);
        expect(choices(menu("bonne"))).toEqual(["1h", "tonight", "tomorrow"]);
    });

    it("says each delay in the app's words, and marks the one Escape takes", () => {
        const html = menu("important");
        expect(html).toContain(t("boss.visit.later.15min"));
        expect(html).toContain(t("boss.visit.later.tonight"));
        expect(html).toMatch(/is-default[^>]*data-choice="15min"/);
        expect((html.match(/is-default/g) ?? []).length).toBe(1);
        expect(html).toContain('role="menu"');
    });
});

describe("a click on the scene folds it and opens his panel (AC6)", () => {
    function visitUp() {
        const fixture = hubFixture();
        fixture.hub.syncRows([
            {
                key: "agent:a",
                tone: "waiting",
                notice: null,
                lineFromNotice: false,
                name: "a",
                line: { text: "a" },
                place: "",
                since: T - 6 * Min,
                rank: 1,
                seen: false,
                actions: [],
            },
        ]);
        expect(fixture.hub.getView().visit).not.toBeNull();
        return fixture;
    }

    it("is one gesture: the panel opens once and the scene folds", () => {
        const { hub, panels } = visitUp();
        sceneActions(hub).fold();
        expect(panels()).toBe(1);
        expect(hub.getView().visit).toBeNull();
    });

    it("does not open his panel to push him back with Plus tard", () => {
        const { hub, panels } = visitUp();
        sceneActions(hub).choose("15min");
        expect(panels()).toBe(0);
        expect(hub.getView().visit).toBeNull();
        expect(hub.getView().laterUntil).toBe(T + 15 * Min);
    });

    it("takes the default delay of the severity on Escape", () => {
        const { hub, panels } = visitUp();
        sceneActions(hub).escape();
        expect(panels()).toBe(0);
        expect(hub.getView().laterUntil).toBe(T + 15 * Min);
    });
});

describe("the title row stays on top and clickable (AC6)", () => {
    const scene = css("brokk-visit-scene.css");
    const sidebar = css("sidebar.css", join(__dirname, "..", "sidebar"));
    const zIndex = (declarations: string) => Number(/z-index: (\d+)/.exec(declarations)?.[1]);

    it("stands under the window row, so that the window buttons and the sidebar button are not covered", () => {
        const layer = zIndex(rule(scene, ".mt-brokk-scene-layer"));
        const row = zIndex(rule(sidebar, ".mt-sb-window-row"));
        expect(layer).toBeGreaterThan(0);
        expect(row).toBeGreaterThan(layer);
        expect(rule(sidebar, ".mt-sb-window-row")).toMatch(/position: relative/);
    });

    it("takes no pointer outside its own box, and none through its gradient", () => {
        expect(rule(scene, ".mt-brokk-scene-layer")).toMatch(/pointer-events: none/);
        expect(rule(scene, ".mt-brokk-scene-topfade")).toMatch(/pointer-events: none/);
        expect(rule(scene, ".mt-brokk-scene")).toMatch(/pointer-events: none/);
        expect(rule(scene, '.mt-brokk-scene[data-open="true"]')).toMatch(/pointer-events: auto/);
    });

    it("has a subtle top gradient under the row, not a bar", () => {
        const topfade = rule(scene, ".mt-brokk-scene-topfade");
        expect(topfade).toMatch(/linear-gradient\(to bottom, rgba\(10, 8, 7, 0\.6\), rgba\(10, 8, 7, 0\)\)/);
        expect(topfade).not.toMatch(/border/);
    });
});

describe("where the scene stands (AC6)", () => {
    const scene = css("brokk-visit-scene.css");
    const sidebar = css("sidebar.css", join(__dirname, "..", "sidebar"));

    it("starts at y = 0 and runs to both side edges, with no margin, box or rounded card of its own", () => {
        const layer = rule(scene, ".mt-brokk-scene-layer");
        expect(layer).toMatch(/top: 0/);
        expect(layer).toMatch(/left: 0/);
        expect(layer).toMatch(/right: 0/);
        const body = rule(scene, ".mt-brokk-scene");
        expect(body).toMatch(/inset: 0/);
        expect(body).not.toMatch(/margin|border|box-shadow|border-radius/);
    });

    it("ends 8 px above the search field once the content has slid down by 84 px", () => {
        expect(SceneRoomPx).toBe(84);
        expect(SceneGapPx).toBe(8);
        const layer = rule(scene, ".mt-brokk-scene-layer");
        expect(layer).toContain(`--mt-brokk-room: ${SceneRoomPx}px`);
        expect(layer).toContain(`--mt-brokk-gap: ${SceneGapPx}px`);
        expect(layer).toMatch(/height: calc\(var\(--mt-brokk-field-top\) \+ var\(--mt-brokk-room\) - var\(--mt-brokk-gap\)\)/);
        expect(rule(sidebar, '.mt-sb[data-brokk-visit="open"] .mt-brokk-room')).toContain(`margin-top: ${SceneRoomPx}px`);
    });

    it("fades its bottom over 60 px into the sidebar's own background, the workspace tint included", () => {
        expect(SceneFadePx).toBe(60);
        const fade = rule(scene, ".mt-brokk-scene-fade");
        expect(fade).toContain(`height: ${SceneFadePx}px`);
        expect(fade).toMatch(/linear-gradient\(to bottom, transparent, var\(--mt-surface-0\)\)/);
        const tinted = rule(scene, ".mt-sb.is-tinted .mt-brokk-scene-fade::after");
        expect(tinted).toContain("var(--mt-place)");
        expect(tinted).toMatch(/18%/);
    });

    it("counts the floating sidebar's own inner margin when it floats over the content", () => {
        expect(rule(scene, ".mt-sb.is-hidden .mt-brokk-scene-layer")).toContain("2 * var(--mt-peek-inset");
    });
});

describe("how long it takes (AC6)", () => {
    const scene = css("brokk-visit-scene.css");
    const sidebar = css("sidebar.css", join(__dirname, "..", "sidebar"));

    it("grows from the avatar in about 360 ms with an ease-out, and folds back in about 300 ms", () => {
        expect(MotionTimings.openMs).toBe(360);
        expect(MotionTimings.closeMs).toBe(300);
        expect(rule(scene, '.mt-brokk-scene[data-open="true"]')).toMatch(/transform 360ms cubic-bezier\(0\.2, 0\.7, 0\.2, 1\)/);
        expect(rule(scene, ".mt-brokk-scene")).toMatch(/transform 300ms ease-in/);
    });

    it("slides the content down in about 320 ms and back up in about 300 ms", () => {
        expect(MotionTimings.slideDownMs).toBe(320);
        expect(rule(sidebar, '.mt-sb[data-brokk-visit="open"] .mt-brokk-room')).toMatch(/margin-top 320ms/);
        expect(rule(sidebar, ".mt-brokk-room")).toMatch(/margin-top 300ms ease-in/);
    });
});

describe("the scene under reduced motion (AC6)", () => {
    const scene = css("brokk-visit-scene.css");
    const sidebar = css("sidebar.css", join(__dirname, "..", "sidebar"));

    it("cross-fades in 150 ms and moves nothing, for the app's setting", () => {
        expect(MotionTimings.fadeMs).toBe(150);
        const open = rule(scene, '.prefers-reduced-motion .mt-brokk-scene[data-open="true"]');
        expect(open).toMatch(/transform: none/);
        expect(open).toMatch(/transition: opacity 150ms linear/);
        expect(open).not.toMatch(/transform \d/);
    });

    it("does the same for the system's preference", () => {
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(scene)?.[1] ?? "";
        expect(media).toMatch(/\.mt-brokk-scene,\s*\.mt-brokk-scene\[data-open="true"\]\s*\{[^}]*transform: none;[^}]*transition: opacity 150ms linear/);
    });

    it("lets the glow stand still and draws no embers", () => {
        expect(rule(scene, ".prefers-reduced-motion .mt-brokk-scene-glow")).toMatch(/animation: none/);
        expect(rule(scene, ".prefers-reduced-motion .mt-brokk-scene-embers")).toMatch(/display: none/);
    });

    it("changes the content's place at once", () => {
        expect(rule(sidebar, ".prefers-reduced-motion .mt-brokk-room")).toBe("");
        expect(sidebar).toMatch(/\.prefers-reduced-motion \.mt-brokk-room,\s*\.prefers-reduced-motion \.mt-sb\[data-brokk-visit="open"\] \.mt-brokk-room \{\s*transition: none;/);
        expect(sidebar).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-brokk-room,\s*\.mt-sb\[data-brokk-visit="open"\] \.mt-brokk-room \{\s*transition: none;/);
    });

    it("has the model say the same", () => {
        const reduced = sceneTimings(true);
        expect(reduced.openMs).toBe(150);
        expect(reduced.slideDownMs).toBe(0);
    });
});
