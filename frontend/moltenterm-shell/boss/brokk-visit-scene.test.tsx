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
vi.mock("./use-brokk-hub", () => ({
    useHubSelect: (select: (view: unknown) => unknown) => select(Mocks.hub.getView()),
}));
vi.mock("./use-brokk-live", () => ({ useMotionAllowed: () => Mocks.motion }));
vi.mock("../molten-motion", () => ({ prefersReducedMotion: () => Mocks.reduced }));
const Package = vi.hoisted(() => ({ props: null as Record<string, any> }));
vi.mock("@diamondforge/character", () => ({
    TransmissionPortrait: (props: Record<string, any>) => {
        Package.props = props;
        return null;
    },
}));
vi.mock("@diamondforge/character/styles.css", () => ({}));

import { t } from "../i18n/i18n";
import { BrokkHub, HubDeps } from "./brokk-hub";
import { Severity } from "./brokk-queue";
import type { Visit } from "./brokk-visit";
import { BrokkPortrait, rhythmProps } from "./brokk-portrait";
import { BrokkVisitSceneView, LaterMenu } from "./brokk-visit-scene";
import {
    laterOptions,
    MotionTimings,
    sceneActions,
    SceneFadePx,
    SceneGapPx,
    sceneGestureOf,
    sceneLabel,
    scenePhase,
    SceneRoomPx,
    sceneTimings,
} from "./brokk-visit-scene-model";
import { EmptyShared } from "./brokk-visit-share";

const Severities: Severity[] = ["grave", "important", "neutre", "bonne"];
const T = new Date(2026, 10, 6, 14, 0, 0).getTime();
const Min = 60_000;

function visit(severity: Severity): Visit {
    const expression = { grave: "frown", important: "doubtful", neutre: "call", bonne: "smile" }[severity];
    return { severity, expression: expression as Visit["expression"], keys: ["agent:a"], count: 1 };
}

function render(severity: Severity, shown: boolean = true): string {
    return renderToStaticMarkup(
        <BrokkVisitSceneView visit={visit(severity)} name="Brokk" phase={shown ? "open" : "closing"} rowHeight="38px" />
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

    it("holds one still frame of the clip of the severity under reduced motion, never a loop (#2025)", () => {
        Mocks.motion = false;
        expect(attr(render("grave"), "brokk-scene-video", "src")).toContain("listening.frown");
        expect(attr(render("important"), "brokk-scene-video", "src")).toContain("listening.doubtful");
        expect(attr(render("neutre"), "brokk-scene-video", "src")).toContain("listening.call");
        expect(attr(render("bonne"), "brokk-scene-video", "src")).toContain("listening.smile");
        const html = render("important");
        expect(html).not.toMatch(/autoPlay=""|autoplay=""/i);
        expect(html).not.toMatch(/loop=""/);
        expect(html).toMatch(/muted=""/);
        Package.props = null;
        render("important");
        expect(Package.props).toBeNull();
    });

    it("is his living portrait when motion is allowed, waiting in the listening pose, never a looping clip (#2025)", () => {
        for (const severity of Severities) {
            Package.props = null;
            const html = render(severity);
            expect(html, severity).not.toContain("<video");
            expect(Package.props, severity).not.toBeNull();
            expect(Package.props.state, severity).toBe("listening");
            expect(Package.props.bare, severity).toBe(true);
            expect(Package.props.loops, severity).toBe(BrokkPortrait.loops);
            expect(Package.props.idles, severity).toBe(BrokkPortrait.idles);
            expect(Package.props.idleGap, severity).toEqual(rhythmProps("normal").idleGap);
            expect(Package.props.className, severity).toContain("mt-brokk-scene-portrait");
        }
    });

    it("draws only blinks by chance while he waits: the nod and the faces are on demand", () => {
        const free = BrokkPortrait.idles.listening.filter((idle) => !idle.onDemand).map((idle) => idle.name);
        expect(free).toEqual(["blink"]);
        expect(BrokkPortrait.idles.listening.find((idle) => idle.name === "blink").repeat).toBe(true);
    });

    it("asks the gesture of the severity: raised brows, frown, call or smile", () => {
        expect(sceneGestureOf("important")).toBe("doubtful");
        expect(sceneGestureOf("grave")).toBe("frown");
        expect(sceneGestureOf("neutre")).toBe("call");
        expect(sceneGestureOf("bonne")).toBe("smile");
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
        expect(layer).toMatch(
            /height: calc\(var\(--mt-brokk-field-top\) \+ var\(--mt-brokk-room\) - var\(--mt-brokk-gap\)\)/
        );
        expect(rule(sidebar, '.mt-sb[data-brokk-visit="open"] .mt-brokk-room')).toContain(
            `margin-top: ${SceneRoomPx}px`
        );
    });

    it("fades its bottom over 60 px into the sidebar's own background, whatever it is: a mask, not a colour", () => {
        expect(SceneFadePx).toBe(60);
        expect(rule(scene, ".mt-brokk-scene-layer")).toContain(`--mt-brokk-fade: ${SceneFadePx}px`);
        const art = rule(scene, ".mt-brokk-scene-art");
        expect(art).toMatch(
            /mask-image: linear-gradient\(to bottom, rgb\(0, 0, 0\) calc\(100% - var\(--mt-brokk-fade\)\), transparent\)/
        );
        expect(art).toMatch(/-webkit-mask-image/);
        // A gradient to the sidebar's surface would leave a band on a tinted, textured or see-through sidebar.
        expect(art).not.toMatch(/--mt-surface-0|--mt-place/);
        expect(scene).not.toMatch(/mt-brokk-scene-fade|is-tinted/);
    });

    it("keeps the Plus tard controls out of the faded artwork, so that the fade does not dim them", () => {
        const html = render("important");
        const art = html.slice(html.indexOf("mt-brokk-scene-art"), html.indexOf('data-testid="brokk-scene-hit"'));
        expect(art).toContain("mt-brokk-scene-clip");
        expect(html.indexOf("mt-brokk-later")).toBeGreaterThan(html.indexOf("mt-brokk-scene-topfade"));
        expect(art).not.toContain("brokk-later");
        expect(rule(scene, ".mt-brokk-scene-art")).toMatch(/pointer-events: none/);
    });

    it("counts the floating sidebar's own inner margin when it floats over the content", () => {
        expect(rule(scene, ".mt-sb.is-hidden .mt-brokk-scene-layer")).toContain("2 * var(--mt-peek-inset");
    });
});

describe("the forge has no box (AC6)", () => {
    const scene = css("brokk-visit-scene.css");
    const clip = rule(scene, ".mt-brokk-scene-clip");

    // The stops of each mask declaration (the prefixed one and the standard one) as [alpha, position in %], the first being
    // the transparent start and the last the opaque end.
    function masks(declarations: string): [number, number][][] {
        return [...declarations.matchAll(/mask-image: linear-gradient\(([\s\S]*?)\);/g)].map((gradient) =>
            [...gradient[1].matchAll(/(transparent|rgb\(0, 0, 0\)|rgba\(0, 0, 0, ([\d.]+)\)) (\d+%?)/g)].map((m) => [
                m[1] === "transparent" ? 0 : m[2] == null ? 1 : Number(m[2]),
                parseFloat(m[3]),
            ])
        );
    }

    it("melts the clip's left edge into the scene's dark, so that no vertical line shows between them", () => {
        expect(clip).toMatch(/-webkit-mask-image: linear-gradient\(\s*to right,/);
        expect(clip).toMatch(/[^-]mask-image: linear-gradient\(\s*to right,/);
        const both = masks(clip);
        expect(both).toHaveLength(2);
        for (const list of both) {
            expect(list[0]).toEqual([0, 0]);
            expect(list[list.length - 1][0]).toBe(1);
        }
        expect(both[0]).toEqual(both[1]);
    });

    it("does it over about 40 % of the clip's width, as a gradient that eases and never as a step", () => {
        for (const list of masks(clip)) {
            const opaqueAt = list[list.length - 1][1];
            expect(opaqueAt).toBeGreaterThanOrEqual(35);
            expect(opaqueAt).toBeLessThanOrEqual(45);
            for (let i = 1; i < list.length; i++) {
                expect(list[i][0], `stop ${i}`).toBeGreaterThanOrEqual(list[i - 1][0]);
                expect(list[i][1], `stop ${i}`).toBeGreaterThan(list[i - 1][1]);
                expect(list[i][0] - list[i - 1][0], `step ${i}`).toBeLessThanOrEqual(0.3);
            }
        }
    });

    it("leaves the right side of the clip as it is, and the artwork's bottom to its own mask", () => {
        expect(clip).not.toMatch(/to left|to bottom/);
        expect(rule(scene, ".mt-brokk-scene-art")).toMatch(/mask-image: linear-gradient\(to bottom,/);
    });

    it("lights the glow at its centre and nothing at the edge of its box, so that the box has no outline of its own", () => {
        for (const selector of [
            ".mt-brokk-scene-glow",
            '.mt-brokk-scene[data-severity="grave"] .mt-brokk-scene-glow',
        ]) {
            const glow = rule(scene, selector);
            expect(glow, selector).toMatch(/radial-gradient\(\s*ellipse closest-side,/);
            expect(glow, selector).toMatch(/transparent 100%\s*\)/);
        }
        expect(rule(scene, ".mt-brokk-scene-glow")).not.toMatch(/border-radius/);
    });

    it("has no outline, border or shadow on the clip that would draw its box again", () => {
        expect(clip).not.toMatch(/border|outline|box-shadow/);
        expect(rule(scene, ".mt-brokk-scene-video")).not.toMatch(/border|outline|box-shadow/);
    });
});

describe("the title row holds nothing for the scene to step aside from (AC6, #2003)", () => {
    const sidebar = css("sidebar.css", join(__dirname, "..", "sidebar"));
    const source = readFileSync(join(__dirname, "..", "sidebar", "workspace-sidebar.tsx"), "utf8");
    const windowRow = source.slice(
        source.indexOf("function WindowRow"),
        source.indexOf("// Whether the floating panel")
    );

    it("has no bell and no cup any more: the panel holds what they offered, so there is nothing to fade out", () => {
        expect(windowRow).not.toContain("<NotificationCenter");
        expect(windowRow).not.toContain("<KeepAwakeStatusItem");
        expect(windowRow).not.toContain("mt-brokk-hush");
        expect(sidebar).not.toContain("mt-brokk-hush");
    });

    it("keeps the window buttons, the sidebar button and the avatar in the row", () => {
        for (const kept of ["<AppMenuButton", "<ToggleButton", "<WindowButtonStandIns", "<BrokkAvatarSlot"]) {
            expect(windowRow, kept).toContain(kept);
        }
    });

    it("leaves the sidebar button, the window buttons and the row itself without a fade", () => {
        expect(rule(sidebar, ".mt-sb-window-row")).not.toMatch(/opacity|visibility/);
        expect(sidebar).not.toMatch(/data-brokk-visit="open"\] \.mt-sb-window-row/);
        expect(sidebar).not.toMatch(/data-brokk-visit="open"\] [^{]*(toggle|lights)/);
    });
});

describe("how long it takes (AC6)", () => {
    const scene = css("brokk-visit-scene.css");
    const sidebar = css("sidebar.css", join(__dirname, "..", "sidebar"));

    it("grows from the avatar in about 360 ms with an ease-out, and folds back in about 300 ms", () => {
        expect(MotionTimings.openMs).toBe(360);
        expect(MotionTimings.closeMs).toBe(300);
        const layer = rule(scene, ".mt-brokk-scene-layer");
        expect(layer).toContain(`--mt-brokk-open-ms: ${MotionTimings.openMs}ms`);
        expect(layer).toContain(`--mt-brokk-close-ms: ${MotionTimings.closeMs}ms`);
        expect(rule(scene, '.mt-brokk-scene[data-open="true"]')).toMatch(
            /transform var\(--mt-brokk-open-ms\) cubic-bezier\(0\.2, 0\.7, 0\.2, 1\)/
        );
        expect(rule(scene, ".mt-brokk-scene")).toMatch(/transform var\(--mt-brokk-close-ms\) ease-in/);
    });

    it("slides the content down in about 320 ms and back up in about 300 ms", () => {
        expect(MotionTimings.slideDownMs).toBe(320);
        const room = rule(sidebar, ".mt-brokk-room");
        expect(room).toContain(`--mt-brokk-slide-down-ms: ${MotionTimings.slideDownMs}ms`);
        expect(room).toContain(`--mt-brokk-slide-up-ms: ${MotionTimings.closeMs}ms`);
        expect(rule(sidebar, '.mt-sb[data-brokk-visit="open"] .mt-brokk-room')).toMatch(
            /margin-top var\(--mt-brokk-slide-down-ms\) cubic-bezier/
        );
        expect(room).toMatch(/margin-top var\(--mt-brokk-slide-up-ms\) ease-in/);
    });
});

describe("the scene under reduced motion (AC6)", () => {
    const scene = css("brokk-visit-scene.css");
    const sidebar = css("sidebar.css", join(__dirname, "..", "sidebar"));

    it("cross-fades in 150 ms and moves nothing, for the app's setting", () => {
        expect(MotionTimings.fadeMs).toBe(150);
        expect(rule(scene, ".mt-brokk-scene-layer")).toContain(`--mt-brokk-fade-ms: ${MotionTimings.fadeMs}ms`);
        const open = rule(scene, '.prefers-reduced-motion .mt-brokk-scene[data-open="true"]');
        expect(open).toMatch(/transform: none/);
        expect(open).not.toMatch(/transform var/);
        expect(rule(scene, '.prefers-reduced-motion .mt-brokk-scene[data-phase="open"]')).toMatch(
            /animation: mt-brokk-fade-in var\(--mt-brokk-fade-ms\) linear both/
        );
        expect(rule(scene, '.prefers-reduced-motion .mt-brokk-scene[data-phase="closing"]')).toMatch(
            /animation: mt-brokk-fade-out var\(--mt-brokk-fade-ms\) linear both/
        );
    });

    it("fades with an animation, since the app's reduced-motion rule leaves no transition to fade with", () => {
        const app = readFileSync(join(__dirname, "..", "..", "app", "app.scss"), "utf8");
        expect(app).toMatch(/\.prefers-reduced-motion \{\s*\*\s*\{[^}]*transition-property: none !important/);
        expect(rule(scene, ".prefers-reduced-motion .mt-brokk-scene")).not.toMatch(/transition: opacity/);
        expect(scene).toMatch(/@keyframes mt-brokk-fade-in/);
        expect(scene).toMatch(/@keyframes mt-brokk-fade-out/);
    });

    it("does the same for the system's preference", () => {
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/.exec(scene)?.[1] ?? "";
        expect(media).toMatch(
            /\.mt-brokk-scene,\s*\.mt-brokk-scene\[data-open="true"\]\s*\{[^}]*transform: none;[^}]*transition: none/
        );
        expect(media).toMatch(/\.mt-brokk-scene\[data-phase="open"\]\s*\{[^}]*mt-brokk-fade-in/);
        expect(media).toMatch(/\.mt-brokk-scene\[data-phase="closing"\]\s*\{[^}]*mt-brokk-fade-out/);
    });

    it("draws nothing in the frame before the scene is drawn open, so that it does not flash", () => {
        expect(scenePhase(true, false)).toBe("pre");
        expect(scenePhase(true, true)).toBe("open");
        expect(scenePhase(false, true)).toBe("closing");
        expect(scenePhase(false, false)).toBe("closing");
        expect(rule(scene, '.prefers-reduced-motion .mt-brokk-scene[data-phase="pre"]')).toBe("");
        expect(attr(render("important", true), "brokk-scene", "data-phase")).toBe("open");
        expect(attr(render("important", false), "brokk-scene", "data-phase")).toBe("closing");
    });

    it("lets the glow stand still and draws no embers", () => {
        expect(rule(scene, ".prefers-reduced-motion .mt-brokk-scene-glow")).toMatch(/animation: none/);
        expect(rule(scene, ".prefers-reduced-motion .mt-brokk-scene-embers")).toMatch(/display: none/);
    });

    it("changes the content's place at once", () => {
        expect(rule(sidebar, ".prefers-reduced-motion .mt-brokk-room")).toBe("");
        expect(sidebar).toMatch(
            /\.prefers-reduced-motion \.mt-brokk-room,\s*\.prefers-reduced-motion \.mt-sb\[data-brokk-visit="open"\] \.mt-brokk-room \{\s*transition: none;/
        );
        expect(sidebar).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-brokk-room,\s*\.mt-sb\[data-brokk-visit="open"\] \.mt-brokk-room \{\s*transition: none;/
        );
    });

    it("has the model say the same", () => {
        const reduced = sceneTimings(true);
        expect(reduced.openMs).toBe(150);
        expect(reduced.slideDownMs).toBe(0);
    });
});
