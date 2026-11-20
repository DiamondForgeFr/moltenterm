// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The end of a switch (#2419): a view a switch left invisible is found and restored, on main's side and in its page,
// and the log names what was stuck; a view a newer switch uses is never touched. Fake clock, fake views, a small fake
// page: nothing waits for real time.

import { describe, expect, it } from "vitest";
import {
    LeaveAnimationId as PageLeaveAnimationId,
    LeaveLayerId as PageLeaveLayerId,
    LeaveMaxMs as PageLeaveMaxMs,
} from "../frontend/moltenterm-shell/switch-layout/layout-frames";
import {
    checkSwitchLanding,
    framePaints,
    InvisibleOpacity,
    LandingMainState,
    LandingOutcome,
    LandingPageReport,
    landingProbeScript,
    LeaveAnimationId,
    LeaveLayerId,
    LeaveMaxMs,
    restoreLandingScript,
    stuckMainStates,
    stuckPageStates,
    SwitchLandingCheckMs,
    SwitchLandingDeps,
    SwitchLandingMaxTries,
    SwitchLandingRetryMs,
    watchSwitchLanding,
} from "./moltenterm-switch-landing";
import { SwitchFadeId } from "./moltenterm-switch-picture";

const Clear = "#00000000";

const fine: LandingPageReport = {
    html: 1,
    body: 1,
    bodyVisibility: "visible",
    main: 1,
    content: 1,
    coverMark: false,
    overlay: false,
    cover: false,
    leaveAgeMs: null,
    shown: true,
};

const shown: LandingMainState = {
    inWindow: true,
    onScreen: true,
    visible: true,
    covered: false,
    background: Clear,
    wantsClear: true,
    windowShows: true,
};

// A fake clock: timers run only when the test advances it.
function fakeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
        setTimer: (fn: () => void, ms: number) => {
            const id = ++seq;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimer: (h: unknown) => void timers.delete(h as number),
        async advance(ms: number) {
            const end = now + ms;
            for (;;) {
                const due = Array.from(timers.entries())
                    .filter(([, t]) => t.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (due == null) {
                    break;
                }
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await flush();
            }
            now = end;
            await flush();
        },
        pending: () => timers.size,
    };
}

const flush = async () => {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
};

// A view and its page: main's state and the page's report are plain values the restores change, as the real ones do.
function fakeView(page: Partial<LandingPageReport> = {}, main: Partial<LandingMainState> = {}, painted = true) {
    const state = {
        page: { ...fine, ...page } as LandingPageReport,
        main: { ...shown, ...main } as LandingMainState,
        painted: painted as boolean,
        landed: true,
        busy: false,
        // the page's restore takes: false leaves the page as it was
        restoreWorks: true,
        logs: [] as string[],
        restoredMain: [] as string[][],
        pageRestores: 0,
        probes: 0,
        readbacks: 0,
        cycles: 0,
        // run at each probe: a newer switch starting while the check waits on the page
        onProbe: null as () => void,
    };
    const clock = fakeClock();
    const deps: SwitchLandingDeps = {
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        log: (msg) => state.logs.push(msg),
        stillLanded: () => state.landed,
        busy: () => state.busy,
        mainState: () => ({ ...state.main }),
        restoreMain: (stuck) => {
            state.restoredMain.push(stuck);
            state.main = { ...state.main, inWindow: true, onScreen: true, visible: true, covered: false };
            if (!state.main.wantsClear) {
                state.main.background = "#1f1f1f";
            }
        },
        probePage: async () => {
            state.probes++;
            state.onProbe?.();
            return { ...state.page };
        },
        restorePage: async () => {
            state.pageRestores++;
            if (state.restoreWorks) {
                state.page = { ...fine, shown: state.page.shown };
            }
            return "restored";
        },
        paints: async () => {
            state.readbacks++;
            return state.painted;
        },
        cycleVisibility: () => {
            state.cycles++;
            state.painted = true;
            state.page = { ...state.page, shown: true };
        },
        clearBackground: Clear,
    };
    return { state, deps, clock };
}

async function watchAndLand(v: ReturnType<typeof fakeView>, ms = SwitchLandingCheckMs): Promise<LandingOutcome[]> {
    const outcomes: LandingOutcome[] = [];
    watchSwitchLanding("tab-b", v.deps, (o) => outcomes.push(o));
    await v.clock.advance(ms);
    return outcomes;
}

describe("the page's stuck states", () => {
    it("reads nothing stuck on a drawn page", () => {
        expect(stuckPageStates(fine)).toEqual([]);
        expect(stuckPageStates(null)).toEqual([]);
    });

    it("names each state that leaves the page invisible", () => {
        expect(stuckPageStates({ ...fine, main: 0 })).toEqual(["content at opacity 0"]);
        expect(stuckPageStates({ ...fine, coverMark: true })).toEqual(["cover mark (panels hidden under a picture)"]);
        expect(stuckPageStates({ ...fine, body: 0, bodyVisibility: "hidden" })).toEqual([
            "body at opacity 0",
            "body hidden",
        ]);
        expect(stuckPageStates({ ...fine, html: 0.01, overlay: true, cover: true })).toEqual([
            "picture overlay",
            "picture cover",
            "page at opacity 0",
        ]);
        expect(stuckPageStates({ ...fine, main: InvisibleOpacity })).toEqual([]);
    });

    it("leaves the panels of a view fading under the next workspace's layout on purpose, for LeaveMaxMs", () => {
        expect(stuckPageStates({ ...fine, content: 0, leaveAgeMs: LeaveMaxMs })).toEqual([]);
        expect(stuckPageStates({ ...fine, content: 0 })).toEqual(["panels at opacity 0"]);
        expect(stuckPageStates({ ...fine, content: 0, leaveAgeMs: LeaveMaxMs + 1 })).toEqual([
            "layout leave layer left over",
            "panels at opacity 0",
        ]);
    });

    it("knows the page's layout leave layer as the page names it (#2407)", () => {
        expect(LeaveLayerId).toBe(PageLeaveLayerId);
        expect(LeaveAnimationId).toBe(PageLeaveAnimationId);
        expect(LeaveMaxMs).toBe(PageLeaveMaxMs);
    });
});

describe("main's stuck states", () => {
    it("reads nothing stuck on a view shown with its own look", () => {
        expect(stuckMainStates(shown, Clear)).toEqual([]);
        expect(stuckMainStates({ ...shown, background: "#1f1f1f", wantsClear: false }, Clear)).toEqual([]);
    });

    it("names a view hidden, off screen, covered, or let through on an opaque look", () => {
        expect(
            stuckMainStates({ ...shown, visible: false, onScreen: false, covered: true, inWindow: false }, Clear)
        ).toEqual(["not in the window", "off screen", "hidden", "under another view"]);
        expect(stuckMainStates({ ...shown, wantsClear: false }, Clear)).toEqual([
            "let through (background cleared on an opaque look)",
        ]);
    });
});

describe("the pixel test", () => {
    const band = (alpha: number[], rgb = 0) => {
        const b = new Uint8Array(alpha.length * 4);
        alpha.forEach((a, i) => {
            b[i * 4] = rgb;
            b[i * 4 + 1] = rgb;
            b[i * 4 + 2] = rgb;
            b[i * 4 + 3] = a;
        });
        return { bitmap: b, size: { width: alpha.length, height: 1 } };
    };

    it("finds nothing painted in a fully transparent band", () => {
        const f = band(new Array(100).fill(0));
        expect(framePaints(f.bitmap, f.size)).toBe(false);
    });

    it("finds a dark, flat band painted: an empty terminal or a folded sidebar is drawn", () => {
        const f = band(new Array(100).fill(255), 20);
        expect(framePaints(f.bitmap, f.size)).toBe(true);
    });

    it("cannot tell from a missing or short band", () => {
        expect(framePaints(null, { width: 10, height: 10 })).toBeNull();
        expect(framePaints(new Uint8Array(8), { width: 10, height: 10 })).toBeNull();
    });
});

describe("the landing check", () => {
    it("logs a switch that landed well, and changes nothing", async () => {
        const v = fakeView();
        const outcomes = await watchAndLand(v);
        expect(outcomes).toEqual([{ stuck: [] }]);
        expect(v.state.pageRestores).toBe(0);
        expect(v.state.restoredMain).toEqual([]);
        expect(v.state.cycles).toBe(0);
        expect(v.state.logs).toEqual([
            `[#2419] switch to tab-b landed: on screen, visible, background ${Clear}, content opacity 1, painted`,
        ]);
    });

    it("runs only once the switch has settled", async () => {
        const v = fakeView({ main: 0 });
        expect(await watchAndLand(v, SwitchLandingCheckMs - 1)).toEqual([]);
        expect(v.state.pageRestores).toBe(0);
        await v.clock.advance(1);
        expect(v.state.pageRestores).toBe(1);
    });

    // The gold's case: the view on screen, its panels mounted, nothing drawn.
    it("brings back a view left at opacity 0, looks again, and names the stuck state", async () => {
        const v = fakeView({ main: 0, coverMark: true });
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].stuck).toEqual(["cover mark (panels hidden under a picture)", "content at opacity 0"]);
        expect(outcomes[0].remaining).toEqual([]);
        expect(v.state.page).toEqual(fine);
        expect(v.state.probes).toBe(2);
        expect(v.state.logs).toEqual([
            "[#2419] the view tab-b was left invisible after its switch (cover mark (panels hidden under a picture); content at opacity 0): restored to visible and opaque",
        ]);
    });

    it("says so when the restore did not take", async () => {
        const v = fakeView({ main: 0 });
        v.state.restoreWorks = false;
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].remaining).toEqual(["content at opacity 0"]);
        expect(v.state.logs).toEqual([
            "[#2419] the view tab-b was left invisible after its switch (content at opacity 0): still stuck: content at opacity 0",
        ]);
    });

    it("puts back main's side: hidden, off screen, under another view, let through", async () => {
        const v = fakeView({}, { visible: false, onScreen: false, covered: true, wantsClear: false });
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].stuck).toEqual([
            "off screen",
            "hidden",
            "under another view",
            "let through (background cleared on an opaque look)",
        ]);
        expect(v.state.restoredMain).toHaveLength(1);
        expect(v.state.main).toMatchObject({ visible: true, onScreen: true, covered: false, background: "#1f1f1f" });
        expect(v.state.logs[0]).toContain("(off screen; hidden");
        expect(v.state.logs[0]).toContain("restored to visible and opaque");
    });

    it("cycles the visibility of a view whose page looks drawn but whose band holds nothing", async () => {
        const v = fakeView({}, {}, false);
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].stuck).toEqual(["nothing painted"]);
        expect(v.state.cycles).toBe(1);
        expect(v.state.logs[0]).toContain("(nothing painted): restored to visible and opaque");
    });

    it("reads nothing back, and cycles nothing, in a window that does not show its frames", async () => {
        const v = fakeView({}, { windowShows: false }, false);
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].stuck).toEqual([]);
        expect(v.state.readbacks).toBe(0);
        expect(v.state.cycles).toBe(0);
    });

    it("cycles nothing when the readback cannot tell", async () => {
        const v = fakeView({}, {}, null);
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].stuck).toEqual([]);
        expect(v.state.cycles).toBe(0);
        expect(v.state.logs[0]).not.toContain("painted");
    });

    it("cycles the visibility of a page that believes it is hidden in a window that shows it", async () => {
        const v = fakeView({ shown: false });
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].stuck).toEqual(["page hidden while on screen"]);
        expect(v.state.cycles).toBe(1);
        expect(v.state.page.shown).toBe(true);
        expect(v.state.logs[0]).toContain("(page hidden while on screen): restored to visible and opaque");
    });

    it("leaves alone a page hidden because its window cannot show it (covered, minimised, a background test)", async () => {
        const v = fakeView({ shown: false }, { windowShows: false });
        const outcomes = await watchAndLand(v);
        expect(outcomes[0].stuck).toEqual([]);
        expect(v.state.cycles).toBe(0);
    });

    it("waits for the window's running action, and gives up on a view no longer shown", async () => {
        const v = fakeView({ main: 0 });
        v.state.busy = true;
        expect(await watchAndLand(v)).toEqual([]);
        await v.clock.advance(SwitchLandingRetryMs * 2);
        expect(v.state.pageRestores).toBe(0);
        v.state.busy = false;
        await v.clock.advance(SwitchLandingRetryMs);
        expect(v.state.pageRestores).toBe(1);

        const left = fakeView({ main: 0 });
        left.state.landed = false;
        expect(await watchAndLand(left)).toEqual([{ stuck: [], skipped: "left" }]);
        expect(left.state.pageRestores).toBe(0);
        expect(left.state.logs).toEqual([]);
    });

    // M1: a cold view opening for seconds keeps the window busy; the view still on screen wears the next switch's
    // picture on purpose, and the check must not strip it.
    it("gives up on a window that stays busy, touching nothing", async () => {
        const v = fakeView({ main: 0, overlay: true });
        v.state.busy = true;
        const outcomes = await watchAndLand(
            v,
            SwitchLandingCheckMs + SwitchLandingRetryMs * (SwitchLandingMaxTries + 2)
        );
        expect(outcomes).toEqual([{ stuck: [], skipped: "busy" }]);
        expect(v.state.probes).toBe(0);
        expect(v.state.pageRestores).toBe(0);
        expect(v.state.logs).toEqual([]);
    });

    it("leaves the page alone when a switch starts while it waits on the page", async () => {
        const v = fakeView({ main: 0, overlay: true });
        v.state.onProbe = () => (v.state.busy = true);
        const outcomes = await watchAndLand(v);
        expect(outcomes).toEqual([{ stuck: [], skipped: "busy" }]);
        expect(v.state.pageRestores).toBe(0);
        expect(v.state.logs).toEqual([]);
    });

    it("reads nothing back and cycles nothing once a switch has started", async () => {
        const v = fakeView({}, {}, false);
        v.state.onProbe = () => (v.state.busy = true);
        expect(await watchAndLand(v)).toEqual([{ stuck: [], skipped: "busy" }]);
        expect(v.state.readbacks).toBe(0);
        expect(v.state.cycles).toBe(0);

        const late = fakeView({}, {}, false);
        late.deps.paints = async () => {
            late.state.busy = true;
            return false;
        };
        expect(await watchAndLand(late)).toEqual([{ stuck: [], skipped: "busy" }]);
        expect(late.state.cycles).toBe(0);
    });

    it("is cancelled by a switch that starts, before it runs or in the middle of its check", async () => {
        const v = fakeView({ main: 0 });
        const outcomes: LandingOutcome[] = [];
        const cancel = watchSwitchLanding("tab-b", v.deps, (o) => outcomes.push(o));
        cancel();
        await v.clock.advance(SwitchLandingCheckMs * 2);
        expect(outcomes).toEqual([]);
        expect(v.clock.pending()).toBe(0);

        const mid = fakeView({ main: 0 });
        const midOutcomes: LandingOutcome[] = [];
        const stop = watchSwitchLanding("tab-b", mid.deps, (o) => midOutcomes.push(o));
        mid.state.onProbe = () => stop();
        await mid.clock.advance(SwitchLandingCheckMs);
        expect(midOutcomes).toEqual([{ stuck: [], skipped: "left" }]);
        expect(mid.state.pageRestores).toBe(0);
    });

    it("goes on when the page does not answer", async () => {
        const v = fakeView();
        v.deps.probePage = () => new Promise<LandingPageReport>(() => {});
        const done = checkSwitchLanding("tab-b", v.deps);
        await v.clock.advance(5000);
        expect((await done).stuck).toEqual([]);
        expect(v.state.logs[0]).toContain("content opacity unknown (the page did not answer)");
    });
});

// The scripts, on a small fake page: computed opacity reads the element's inline opacity, or the stylesheet's rule
// html[data-mt-cover="translucent"] #main { opacity: 0 }, or a running animation's value.
type Anim = { id: string; value: number; cancel(): void };
type El = {
    id: string;
    className: string;
    style: Record<string, string>;
    attrs: Map<string, string>;
    dataset: Record<string, string>;
    anims: Anim[];
    removed?: boolean;
    getAttribute(k: string): string;
    setAttribute(k: string, v: string): void;
    hasAttribute(k: string): boolean;
    removeAttribute(k: string): void;
    getAnimations(): Anim[];
    remove(): void;
};

function el(id = "", className = ""): El {
    const e: El = {
        id,
        className,
        style: { opacity: "", visibility: "", background: "" },
        attrs: new Map(),
        dataset: {},
        anims: [],
        getAttribute: (k) => e.attrs.get(k) ?? null,
        setAttribute: (k, v) => void e.attrs.set(k, v),
        hasAttribute: (k) => e.attrs.has(k),
        removeAttribute: (k) => void e.attrs.delete(k),
        getAnimations: () => e.anims,
        remove: () => {
            e.removed = true;
        },
    };
    return e;
}

function fakePage() {
    const root = el();
    const body = el();
    const main = el("main");
    const content = el("", "mt-frame-content");
    const extra: El[] = [];
    const animate = (e: El, value: number, id = "") => {
        const a: Anim = {
            id,
            value,
            cancel: () => {
                e.anims = e.anims.filter((x) => x !== a);
            },
        };
        e.anims.push(a);
    };
    const computed = (e: El) => {
        let opacity = e.style.opacity === "" ? 1 : parseFloat(e.style.opacity);
        if (e === main && root.attrs.get("data-mt-cover") === "translucent") {
            opacity = 0;
        }
        if (e.anims.length > 0) {
            opacity = e.anims[e.anims.length - 1].value;
        }
        return { opacity: String(opacity), visibility: e.style.visibility || "visible" };
    };
    const document = {
        documentElement: root,
        body,
        visibilityState: "visible",
        getElementById: (id: string) => (id === "main" ? main : (extra.find((x) => x.id === id && !x.removed) ?? null)),
        querySelector: (sel: string) => (sel === ".mt-frame-content" ? content : null),
    };
    const window: Record<string, unknown> = {};
    const run = (script: string) =>
        new Function("document", "window", "getComputedStyle", `return (${script});`)(document, window, computed);
    const report = () => run(landingProbeScript()) as LandingPageReport;
    return {
        root,
        body,
        main,
        content,
        extra,
        window,
        animate,
        run,
        report,
        add: (id: string) => {
            const x = el(id);
            extra.push(x);
            return x;
        },
    };
}

describe("the page scripts", () => {
    it("report a drawn page as drawn", () => {
        const p = fakePage();
        expect(p.report()).toEqual(fine);
        expect(stuckPageStates(p.report())).toEqual([]);
    });

    it("bring back a page left under the cover mark, an overlay and its cover", () => {
        const p = fakePage();
        p.root.setAttribute("data-mt-cover", "translucent");
        const ov = p.add("mt-switch-overlay");
        ov.setAttribute("data-mt-through", "|");
        p.add("mt-switch-cover");
        expect(stuckPageStates(p.report())).toEqual([
            "cover mark (panels hidden under a picture)",
            "picture overlay",
            "picture cover",
            "content at opacity 0",
        ]);
        expect(p.run(restoreLandingScript())).toBe("overlay,cover,cover-mark");
        expect(stuckPageStates(p.report())).toEqual([]);
        expect(p.window.__mtCoverGiveUp).toBe(true);
    });

    it("cancel a switch's fade holding the content at opacity 0, and an inline opacity", () => {
        const p = fakePage();
        p.animate(p.main, 0, SwitchFadeId);
        p.body.style.opacity = "0";
        p.body.style.visibility = "hidden";
        expect(stuckPageStates(p.report())).toEqual(["body at opacity 0", "body hidden", "content at opacity 0"]);
        expect(p.run(restoreLandingScript())).toBe("body-opacity,body-hidden,content-opacity");
        expect(p.main.anims).toEqual([]);
        expect(stuckPageStates(p.report())).toEqual([]);
    });

    it("never cancel the page's own animations", () => {
        const p = fakePage();
        p.animate(p.main, 0.5, "mt-view-pour");
        expect(p.run(restoreLandingScript())).toBe("clean");
        expect(p.main.anims.map((a) => a.id)).toEqual(["mt-view-pour"]);
    });

    it("leave the panels of a view being left under the next layout alone", () => {
        const p = fakePage();
        p.content.style.opacity = "0";
        p.add(LeaveLayerId).dataset.at = String(Date.now());
        expect(stuckPageStates(p.report())).toEqual([]);
        expect(p.run(restoreLandingScript())).toBe("clean");
        expect(p.content.style.opacity).toBe("0");
    });

    it("take off a layout leave layer left over past LeaveMaxMs, and its faded panels", () => {
        const p = fakePage();
        p.animate(p.content, 0, LeaveAnimationId);
        const layer = p.add(LeaveLayerId);
        layer.dataset.at = String(Date.now() - LeaveMaxMs - 1000);
        expect(stuckPageStates(p.report())).toEqual(["layout leave layer left over", "panels at opacity 0"]);
        expect(p.run(restoreLandingScript())).toBe("leave-layer,panels-opacity");
        expect(layer.removed).toBe(true);
        expect(stuckPageStates(p.report())).toEqual([]);
    });
});
