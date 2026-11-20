// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The switch picture (#2375): the store, the rules, the scripts run in the views (on a small fake page) and the
// choreography of one window's switch, with a fake clock and fake views. Nothing here waits for real time.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    armPictureScript,
    CoverAttribute,
    CoverHidesRoot,
    attachCoverScript,
    encodeWaitMs,
    giveUpCoverScript,
    quietUntilAfter,
    SwitchEncodeQuietMs,
    PictureAttribute,
    prepareCoverScript,
    isSettled,
    pictureFits,
    prunePictures,
    removeCoverScript,
    removeOverlayScript,
    SettleReport,
    settleProbeScript,
    showPictureScript,
    StableProbes,
    SwitchArmedMs,
    SwitchCoverMaxMs,
    SwitchHoldMaxMs,
    SwitchMotion,
    SwitchPicture,
    SwitchPictureDeps,
    SwitchPictureLimits,
    SwitchPictureStore,
    SwitchSettleMaxMs,
    SwitchSettlePollMs,
    SwitchView,
    swallowsKey,
    uncoverScript,
    waitingCaptionKey,
    waitingScript,
    clearSwitchScript,
    SwitchClearAfterMs,
    mountedBlocksScript,
    PanelsMountMaxMs,
    waitPanelsMounted,
    withDeadline,
    WindowSwitchPicture,
    LayoutSwitchMaxMs,
    takesLayout,
} from "./moltenterm-switch-picture";

const tokensCss = readFileSync("frontend/moltenterm-shell/tokens.css", "utf8");
const shellCss = readFileSync("frontend/moltenterm-shell/moltenterm-shell.css", "utf8");

const pic = (tabId: string, workspaceId: string, at: number, over: Partial<SwitchPicture> = {}): SwitchPicture => ({
    tabId,
    workspaceId,
    width: 1000,
    height: 700,
    at,
    translucent: false,
    mime: "image/jpeg",
    bytes: Uint8Array.from(tabId.split("").map((c) => c.charCodeAt(0))),
    ...over,
});

describe("the motion tokens (#2375)", () => {
    it("keeps the constants in step with tokens.css, the one source the page reads first", () => {
        const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss)?.[1].trim();
        expect(token("--mt-duration-base")).toBe(`${SwitchMotion.fadeInMs}ms`);
        expect(token("--mt-duration-fast")).toBe(`${SwitchMotion.dissolveMs}ms`);
        expect(token("--mt-ease")).toBe(SwitchMotion.easing);
    });

    it("lies in the 150 to 250 ms band the spec asks for", () => {
        expect(SwitchMotion.fadeInMs).toBeGreaterThanOrEqual(150);
        expect(SwitchMotion.fadeInMs).toBeLessThanOrEqual(250);
    });

    it("names the cover attribute the stylesheet answers to: a see-through page stays out of sight under its picture", () => {
        expect(shellCss).toContain(`html[${CoverAttribute}="${CoverHidesRoot}"] #main {`);
        expect(shellCss).toMatch(/html\[data-mt-cover="translucent"\] #main {\s*opacity: 0;/);
    });

    it("says the same words as the pending state while it waits", () => {
        expect(waitingCaptionKey("loading")).toBe("shell.pending.opening");
        expect(waitingCaptionKey("retrying")).toBe("shell.pending.stillOpening");
    });
});

describe("the picture store", () => {
    it("keeps the last entries only", () => {
        const store = new SwitchPictureStore(2, 1000);
        store.put(pic("a", "wa", 1));
        store.put(pic("b", "wb", 2));
        store.put(pic("c", "wc", 3));
        expect(store.size).toBe(2);
        expect(store.forTab("a", 4)).toBeNull();
        expect(store.forTab("b", 4)).not.toBeNull();
    });

    it("replaces a tab's picture by its newer one", () => {
        const store = new SwitchPictureStore();
        store.put(pic("a", "wa", 1, { bytes: Uint8Array.of(1) }));
        store.put(pic("a", "wa", 5, { bytes: Uint8Array.of(2) }));
        expect(store.size).toBe(1);
        expect(store.forTab("a", 6).bytes[0]).toBe(2);
    });

    it("lets a picture go once it is too old", () => {
        const store = new SwitchPictureStore(6, 1000);
        store.put(pic("a", "wa", 0));
        expect(store.forTab("a", 1000)).not.toBeNull();
        expect(store.forTab("a", 1001)).toBeNull();
        expect(store.size).toBe(0);
    });

    it("gives a workspace the view it was left on, the latest of its pictures", () => {
        const store = new SwitchPictureStore();
        store.put(pic("t1", "w", 10));
        store.put(pic("t2", "w", 20));
        store.put(pic("t3", "other", 30));
        expect(store.forWorkspace("w", 40).tabId).toBe("t2");
        expect(store.forTarget({ workspaceId: "w" }, 40).tabId).toBe("t2");
        expect(store.forTarget({ tabId: "t1" }, 40).tabId).toBe("t1");
        expect(store.forTarget({}, 40)).toBeNull();
        expect(store.forTarget(null, 40)).toBeNull();
    });

    it("drops what goes away: a tab, a workspace, the tabs that no longer exist", () => {
        const store = new SwitchPictureStore();
        store.put(pic("a", "w1", 1));
        store.put(pic("b", "w1", 2));
        store.put(pic("c", "w2", 3));
        store.put(pic("d", "w3", 4));
        store.dropTab("a");
        expect(store.forTab("a", 5)).toBeNull();
        store.dropWorkspace("w1");
        expect(store.forTab("b", 5)).toBeNull();
        store.keepOnly(new Set(["c"]));
        expect(store.size).toBe(1);
        store.clear();
        expect(store.size).toBe(0);
    });

    it("drops the pictures of tabs the backend no longer has, whichever path closed them", async () => {
        const store = new SwitchPictureStore();
        store.put(pic("a", "w1", 1));
        store.put(pic("b", "w1", 2));
        store.put(pic("c", "w2", 3));
        const asked: string[][] = [];
        const dropped = await prunePictures(store, async (ids) => {
            asked.push(ids);
            return new Set(["b"]);
        });
        expect(asked).toEqual([["a", "b", "c"]]);
        expect(dropped).toBe(2);
        expect(store.tabIds()).toEqual(["b"]);
    });

    it("drops nothing when the backend does not answer, and asks nothing when there is nothing to ask", async () => {
        const store = new SwitchPictureStore();
        let calls = 0;
        expect(await prunePictures(store, async () => (calls++, new Set<string>()))).toBe(0);
        expect(calls).toBe(0);
        store.put(pic("a", "w1", 1));
        expect(
            await prunePictures(store, async () => {
                throw new Error("no answer");
            })
        ).toBe(0);
        expect(store.tabIds()).toEqual(["a"]);
    });

    it("keeps a picture put while the backend was answering", async () => {
        const store = new SwitchPictureStore();
        store.put(pic("a", "w1", 1));
        await prunePictures(store, async () => {
            store.put(pic("fresh", "w1", 2));
            return new Set<string>();
        });
        expect(store.tabIds()).toEqual(["fresh"]);
    });

    it("keeps few and small pictures: six, of at most 1600 px", () => {
        expect(SwitchPictureLimits.maxEntries).toBe(6);
        expect(SwitchPictureLimits.maxWidthPx).toBeLessThanOrEqual(1600);
        expect(SwitchPictureLimits.maxAgeMs).toBe(30 * 60 * 1000);
    });
});

describe("what a picture fits", () => {
    it("fits the window's size within a pixel, nothing else", () => {
        const p = pic("a", "w", 0);
        expect(pictureFits(p, 1000, 700)).toBe(true);
        expect(pictureFits(p, 1001, 699)).toBe(true);
        expect(pictureFits(p, 1002, 700)).toBe(false);
        expect(pictureFits(p, 1000, 640)).toBe(false);
        expect(pictureFits(null, 1000, 700)).toBe(false);
    });
});

describe("the keys held while the screen shows the target", () => {
    it("holds back what is typed, whatever its place in the interface", () => {
        expect(swallowsKey({})).toBe(true);
        expect(swallowsKey({ shift: true })).toBe(true);
        expect(swallowsKey({ control: true })).toBe(true);
    });

    it("lets a shortcut through, so a second switch or a quit still works", () => {
        expect(swallowsKey({ meta: true })).toBe(false);
        expect(swallowsKey({ alt: true })).toBe(false);
        expect(swallowsKey({ control: true, shift: true })).toBe(false);
        expect(swallowsKey(null)).toBe(false);
    });
});

describe("what counts as settled", () => {
    const report = (blocks: number, visible = true): SettleReport => ({ blocks, visible });

    it("waits for every panel the tab holds, on a page that is on screen", () => {
        expect(isSettled(report(4), 4, 0)).toBe(true);
        expect(isSettled(report(5), 4, 0)).toBe(true);
        expect(isSettled(report(2), 4, 0)).toBe(false);
        expect(isSettled(report(4, false), 4, 0)).toBe(false);
        expect(isSettled(report(-1), 0, 0)).toBe(false);
        expect(isSettled(null, 0, 0)).toBe(false);
        expect(isSettled(report(0), 0, 0)).toBe(true);
    });

    it("settles on a count that stopped changing when the page draws fewer panels than the tab holds", () => {
        expect(isSettled(report(2), 4, StableProbes - 1)).toBe(false);
        expect(isSettled(report(2), 4, StableProbes)).toBe(true);
        expect(isSettled(report(0), 4, StableProbes)).toBe(false);
    });
});

// A page just big enough for the scripts: elements, attributes, the page's tokens, animate() recorded.
type FakeEl = {
    tagName: string;
    id: string;
    className: string;
    textContent: string;
    style: { cssText: string; opacity?: string };
    children: FakeEl[];
    parent: FakeEl;
    attrs: Map<string, string>;
    src?: string;
    alt?: string;
    decoding?: string;
    isConnected: boolean;
    appendChild(c: FakeEl): FakeEl;
    remove(): void;
    setAttribute(k: string, v: string): void;
    getAttribute(k: string): string;
    removeAttribute(k: string): void;
    hasAttribute(k: string): boolean;
    querySelector(sel: string): FakeEl;
    animate(frames: unknown, opts: unknown): { onfinish?: () => void; oncancel?: () => void };
    decode(): Promise<void>;
};

type FakePage = ReturnType<typeof fakePage>;

function fakePage(
    opts: {
        tokens?: Record<string, string>;
        reduced?: boolean;
        blocks?: string[];
        visible?: boolean;
        withMain?: boolean;
        // the blob URL the preload made; null: the picture never arrived
        picture?: string | null;
        // an image decodes only once releaseDecodes() says so
        slowDecode?: boolean;
    } = {}
) {
    const decodeGates: (() => void)[] = [];
    const animations:{ el: FakeEl; frames: any; opts: any; finish: () => void }[] = [];
    const timers: (() => void)[] = [];
    const delays: number[] = [];
    const root = makeEl("html");
    const body = makeEl("body");
    const all = new Set<FakeEl>();
    function makeEl(tag: string): FakeEl {
        const el: FakeEl = {
            tagName: tag.toUpperCase(),
            id: "",
            className: "",
            textContent: "",
            style: { cssText: "" },
            children: [],
            parent: null,
            attrs: new Map(),
            isConnected: false,
            appendChild(c) {
                c.parent = el;
                el.children.push(c);
                c.isConnected = true;
                all.add(c);
                return c;
            },
            remove() {
                if (el.parent != null) {
                    el.parent.children = el.parent.children.filter((c) => c !== el);
                }
                el.parent = null;
                el.isConnected = false;
                all.delete(el);
            },
            setAttribute(k, v) {
                el.attrs.set(k, v);
            },
            getAttribute(k) {
                return el.attrs.get(k) ?? null;
            },
            removeAttribute(k) {
                el.attrs.delete(k);
            },
            hasAttribute(k) {
                return el.attrs.has(k);
            },
            querySelector(sel) {
                const cls = sel.replace(/^\./, "");
                const walk = (e: FakeEl): FakeEl => {
                    for (const c of e.children) {
                        if (c.className.split(" ").includes(cls)) {
                            return c;
                        }
                        const deeper = walk(c);
                        if (deeper != null) {
                            return deeper;
                        }
                    }
                    return null;
                };
                return walk(el);
            },
            animate(frames, o) {
                const a: { onfinish?: () => void; oncancel?: () => void } = {};
                animations.push({ el, frames, opts: o, finish: () => a.onfinish?.() });
                return a;
            },
            decode() {
                if (!opts.slowDecode) {
                    return Promise.resolve();
                }
                return new Promise<void>((resolve) => decodeGates.push(resolve));
            },
        };
        return el;
    }
    root.isConnected = true;
    body.isConnected = true;
    const byId = (id: string) => Array.from(all).find((e) => e.id === id) ?? null;
    const document = {
        documentElement: root,
        body,
        visibilityState: opts.visible === false ? "hidden" : "visible",
        createElement: (tag: string) => makeEl(tag),
        getElementById: byId,
        querySelector: (sel: string) => (sel === ".prefers-reduced-motion" && opts.reduced ? makeEl("div") : null),
        querySelectorAll: (sel: string) => {
            if (sel !== ".block[data-blockid]") {
                return [];
            }
            return (opts.blocks ?? []).map((id) => {
                const e = makeEl("div");
                e.setAttribute("data-blockid", id);
                return e;
            });
        },
    };
    body.appendChild = body.appendChild.bind(body);
    if (opts.withMain) {
        const main = makeEl("div");
        main.id = "main";
        body.appendChild(main);
    }
    const window ={ matchMedia: () => ({ matches: false }) };
    const getComputedStyle = () => ({ getPropertyValue: (name: string) => opts.tokens?.[name] ?? "" });
    function Image(this: FakeEl) {
        return makeEl("img");
    }
    // The preload puts the picture's blob URL on the root; a page that never got one has none.
    if (opts.picture !== null) {
        root.setAttribute(PictureAttribute, opts.picture ?? "blob:pic");
    }
    // A message channel's message arrives in a later task: here, after the microtasks of the caller.
    const revoked: string[] = [];
    function MessageChannel(this: any) {
        const port1: any = { onmessage: null, close() {} };
        return { port1, port2: { postMessage: () => void Promise.resolve().then(() => port1.onmessage?.({})) } };
    }
    const URLish = { revokeObjectURL: (u: string) => revoked.push(u) };
    const run = (script: string): any =>
        new Function(
            "document",
            "window",
            "getComputedStyle",
            "Image",
            "setTimeout",
            "requestAnimationFrame",
            "MessageChannel",
            "URL",
            `return (${script});`
        )(
            document,
            window,
            getComputedStyle,
            Image,
            (fn: () => void, ms?: number) => {
                delays.push(ms);
                return timers.push(fn);
            },
            (fn: () => void) => fn(),
            MessageChannel,
            URLish
        );
    return {
        run,
        animations,
        timers,
        delays,
        root,
        body,
        document,
        byId,
        revoked,
        releaseDecodes: () => decodeGates.splice(0).forEach((open) => open()),
    };
}

const flush = async () => {
    for (let i = 0; i < 6; i++) {
        await Promise.resolve();
    }
};

describe("the picture script on the view being left", () => {
    const Tokens = { "--mt-duration-base": "180ms", "--mt-duration-fast": "120ms", "--mt-ease": " cubic-bezier(0.2, 0, 0, 1)" };

    it("cross-fades the picture in over the page's own token, taking the pointer", async () => {
        const page = fakePage({ tokens: Tokens });
        expect(page.run(showPictureScript(false))).toBe("ok");
        await flush();
        const overlay = page.byId("mt-switch-overlay");
        expect(overlay).not.toBeNull();
        expect(overlay.style.cssText).toContain("position:fixed");
        expect(overlay.style.cssText).not.toContain("pointer-events:none");
        const layer = overlay.children[0];
        expect(layer.src).toBe("blob:pic");
        expect(layer.style.opacity).toBe("1");
        expect(page.animations).toHaveLength(1);
        expect(page.animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        expect(page.animations[0].opts).toEqual({ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    });

    it("follows the token when it is slowed down, and the constants when the page cannot answer", async () => {
        const slow = fakePage({ tokens: { ...Tokens, "--mt-duration-base": "0.4s" } });
        slow.run(showPictureScript(false));
        await flush();
        expect(slow.animations[0].opts.duration).toBe(400);
        const bare = fakePage();
        bare.run(showPictureScript(false));
        await flush();
        expect(bare.animations[0].opts).toEqual({ duration: SwitchMotion.fadeInMs, easing: SwitchMotion.easing });
    });

    it("appears at once under reduced motion: no animation, still no empty frame", async () => {
        const page = fakePage({ tokens: Tokens, reduced: true });
        page.run(showPictureScript(false));
        await flush();
        expect(page.animations).toHaveLength(0);
        expect(page.byId("mt-switch-overlay").children[0].style.opacity).toBe("1");
    });

    it("changes the picture of a newer switch by a cross-fade, and keeps the old one under until it is in", async () => {
        const page = fakePage({ tokens: Tokens, picture: "blob:first" });
        page.run(showPictureScript(false));
        await flush();
        page.root.setAttribute(PictureAttribute, "blob:second");
        page.run(showPictureScript(false));
        await flush();
        const overlay = page.byId("mt-switch-overlay");
        expect(overlay.children.map((c) => c.src)).toEqual(["blob:first", "blob:second"]);
        page.animations[1].finish();
        expect(overlay.children.map((c) => c.src)).toEqual(["blob:second"]);
    });

    it("goes at once when its view is off screen, fades out when the switch ended without a target", async () => {
        const page = fakePage({ tokens: Tokens });
        page.run(showPictureScript(false));
        await flush();
        expect(page.run(removeOverlayScript(false))).toBe("ok");
        expect(page.byId("mt-switch-overlay")).toBeNull();
        page.root.setAttribute(PictureAttribute, "blob:again");
        page.run(showPictureScript(false));
        await flush();
        page.run(removeOverlayScript(true));
        expect(page.byId("mt-switch-overlay")).not.toBeNull();
        page.animations[page.animations.length - 1].finish();
        expect(page.byId("mt-switch-overlay")).toBeNull();
        expect(page.run(removeOverlayScript(false))).toBe("none");
    });

    it("fades the page's own content out as a see-through picture fades in, and gives it back when the switch ends", async () => {
        const page = fakePage({ tokens: Tokens, withMain: true });
        page.run(showPictureScript(true));
        await flush();
        const main = page.byId("main");
        expect(main.style.opacity).toBe("0");
        expect(page.animations.map((a) => a.el.id || a.el.tagName)).toEqual(["main", "IMG"]);
        expect(page.animations[0].frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
        page.run(removeOverlayScript(true));
        expect(page.animations[page.animations.length - 1].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        page.animations[page.animations.length - 1].finish();
        expect(main.style.opacity).toBe("");
    });

    it("clears an opaque page's own background for a see-through picture and gives it back with the overlay (#2390)", async () => {
        for (const fadeOut of [false, true]) {
            const page = fakePage({ tokens: Tokens, withMain: true });
            (page.body.style as any).background = "rgb(1, 2, 3)";
            page.run(showPictureScript(true));
            await flush();
            expect((page.body.style as any).background).toBe("transparent");
            expect((page.root.style as any).background).toBe("transparent");
            page.run(removeOverlayScript(fadeOut));
            expect((page.body.style as any).background).toBe("rgb(1, 2, 3)");
            expect((page.root.style as any).background ?? "").toBe("");
        }
        const opaque = fakePage({ tokens: Tokens, withMain: true });
        (opaque.body.style as any).background = "rgb(1, 2, 3)";
        opaque.run(showPictureScript(false));
        await flush();
        expect((opaque.body.style as any).background).toBe("rgb(1, 2, 3)");
    });

    it("gives the page its content back at once when it is off screen", async () => {
        const page = fakePage({ tokens: Tokens, withMain: true });
        page.run(showPictureScript(true));
        await flush();
        page.run(removeOverlayScript(false));
        expect(page.byId("main").style.opacity).toBe("");
        expect(page.byId("mt-switch-overlay")).toBeNull();
    });

    it("leaves the page's own content alone under an opaque picture", async () => {
        const page = fakePage({ tokens: Tokens, withMain: true });
        page.run(showPictureScript(false));
        await flush();
        expect(page.byId("main").style.opacity).toBeUndefined();
        expect(page.animations).toHaveLength(1);
    });

    it("arms a picture off screen without drawing anything", () => {
        const page = fakePage({ tokens: Tokens });
        expect(page.run(armPictureScript())).toBe("armed");
        expect(page.byId("mt-switch-overlay")).toBeNull();
    });

    it("waits for the picture's bytes that are still on their way, and shows nothing when they never come", async () => {
        const late = fakePage({ tokens: Tokens, picture: null });
        late.run(showPictureScript(false));
        await flush();
        expect(late.byId("mt-switch-overlay")).toBeNull();
        late.root.setAttribute(PictureAttribute, "blob:late");
        await flush();
        expect(late.byId("mt-switch-overlay").children[0].src).toBe("blob:late");
        const never = fakePage({ tokens: Tokens, picture: null });
        never.run(showPictureScript(false));
        for (let i = 0; i < 60; i++) {
            await flush();
        }
        expect(never.byId("mt-switch-overlay")).toBeNull();
    });

    it("lets the picture go with its overlay: the blob URL is revoked and taken off the page", async () => {
        const page = fakePage({ tokens: Tokens });
        page.run(showPictureScript(false));
        await flush();
        page.run(removeOverlayScript(false));
        expect(page.revoked).toEqual(["blob:pic"]);
        expect(page.root.hasAttribute(PictureAttribute)).toBe(false);
    });

    it("draws the wait over the picture with the page's own dominoes, and takes it away", async () => {
        const page = fakePage({ tokens: Tokens });
        page.run(showPictureScript(false));
        await flush();
        page.run(waitingScript({ phase: "loading", name: "Alpha", caption: "Opening" }));
        const wait = page.byId("mt-switch-wait");
        expect(wait.querySelector("mt-sw-name").textContent).toBe("Alpha");
        expect(wait.querySelector("mt-sw-caption").textContent).toBe("Opening");
        expect(wait.querySelector("df-dominos").children).toHaveLength(8);
        page.run(waitingScript(null));
        expect(page.byId("mt-switch-wait")).toBeNull();
    });
});

describe("the quiet window of the encode", () => {
    it("opens at an intent or a switch and only ever moves later", () => {
        expect(quietUntilAfter(1000, 0)).toBe(1000 + SwitchEncodeQuietMs);
        expect(quietUntilAfter(1500, 1000 + SwitchEncodeQuietMs)).toBe(1500 + SwitchEncodeQuietMs);
        expect(quietUntilAfter(1000, 9000)).toBe(9000);
    });

    it("keeps an encode waiting until the window has closed, and then lets it run", () => {
        const until = quietUntilAfter(1000, 0);
        expect(encodeWaitMs(1200, until)).toBe(until - 1200);
        expect(encodeWaitMs(until, until)).toBe(0);
        expect(encodeWaitMs(until + 5000, until)).toBe(0);
    });
});

describe("the cover on the target", () => {
    const Tokens = { "--mt-duration-base": "180ms", "--mt-duration-fast": "120ms", "--mt-ease": "cubic-bezier(0.2, 0, 0, 1)" };

    // The two steps: decoded to the side, then put on.
    const cover = async (page: FakePage, hidesRoot = false) => {
        await page.run(prepareCoverScript());
        return page.run(attachCoverScript(hidesRoot));
    };

    it("wears the picture without taking the pointer, and marks the page", async () => {
        const page = fakePage({ tokens: Tokens });
        expect(await page.run(prepareCoverScript())).toBe("ready");
        expect(page.byId("mt-switch-cover")).toBeNull();
        expect(page.root.hasAttribute(CoverAttribute)).toBe(false);
        expect(page.run(attachCoverScript(false))).toBe("ok");
        const cover = page.byId("mt-switch-cover");
        expect(cover.style.cssText).toContain("pointer-events:none");
        expect(cover.children[0].src).toBe("blob:pic");
        expect(cover.children[0].style.cssText).toContain("opacity:1");
        expect(page.root.hasAttribute(CoverAttribute)).toBe(true);
    });

    it("puts nothing on the page while it decodes, and nothing at all on a page given up meanwhile", async () => {
        const late = fakePage({ tokens: Tokens, withMain: true, slowDecode: true });
        const pending = late.run(prepareCoverScript()) as Promise<string>;
        await flush();
        // not decoded yet: there is nothing to put on, the page shows what it has
        expect(late.run(attachCoverScript(true))).toBe("not-ready");
        expect(late.byId("mt-switch-cover")).toBeNull();
        expect(late.root.hasAttribute(CoverAttribute)).toBe(false);
        expect(late.byId("main").style.opacity).toBeUndefined();
        late.run(giveUpCoverScript());
        late.releaseDecodes();
        await pending;
        expect(late.run(attachCoverScript(true))).toBe("not-ready");
        expect(late.byId("mt-switch-cover")).toBeNull();
        expect(late.root.hasAttribute(CoverAttribute)).toBe(false);
        // the same page decoded in time gets it
        const onTime = fakePage({ tokens: Tokens, withMain: true, slowDecode: true });
        const done = onTime.run(prepareCoverScript()) as Promise<string>;
        onTime.releaseDecodes();
        expect(await done).toBe("ready");
        expect(onTime.run(attachCoverScript(true))).toBe("ok");
        expect(onTime.byId("mt-switch-cover")).not.toBeNull();
    });

    it("gets the picture on only once: a second attach finds nothing to put on", async () => {
        const page = fakePage({ tokens: Tokens });
        await page.run(prepareCoverScript());
        expect(page.run(attachCoverScript(false))).toBe("ok");
        expect(page.run(attachCoverScript(false))).toBe("not-ready");
    });

    it("shows nothing when the picture never reached the page", async () => {
        const page = fakePage({ tokens: Tokens, picture: null });
        const done = page.run(prepareCoverScript()) as Promise<string>;
        for (let i = 0; i < 60; i++) {
            await flush();
        }
        expect(await done).toBe("missing");
        expect(page.run(attachCoverScript(true))).toBe("not-ready");
        expect(page.byId("mt-switch-cover")).toBeNull();
        expect(page.root.hasAttribute(CoverAttribute)).toBe(false);
    });

    it("dissolves into the live content in --mt-duration-fast, then goes", async () => {
        const page = fakePage({ tokens: Tokens });
        await cover(page, false);
        const done = page.run(uncoverScript()) as Promise<string>;
        expect(page.root.hasAttribute(CoverAttribute)).toBe(false);
        expect(page.animations[0].frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
        expect(page.animations[0].opts).toEqual({ duration: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" });
        expect(page.byId("mt-switch-cover")).not.toBeNull();
        page.animations[0].finish();
        expect(await done).toBe("ok");
        expect(page.byId("mt-switch-cover")).toBeNull();
    });

    it("keeps a see-through page out of sight under its cover and fades it in as the cover fades out", async () => {
        const page = fakePage({ tokens: Tokens, withMain: true });
        await cover(page, true);
        expect(page.root.getAttribute(CoverAttribute)).toBe(CoverHidesRoot);
        const done = page.run(uncoverScript()) as Promise<string>;
        const main = page.byId("main");
        expect(page.root.hasAttribute(CoverAttribute)).toBe(false);
        expect(main.style.opacity).toBe("1");
        expect(page.animations.map((a) => a.el.id || a.el.tagName)).toEqual(["main", "mt-switch-cover"]);
        expect(page.animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        page.animations.forEach((a) => a.finish());
        expect(await done).toBe("ok");
        expect(main.style.opacity).toBe("");
    });

    it("marks an opaque cover without hiding anything", async () => {
        const page = fakePage({ tokens: Tokens, withMain: true });
        await cover(page, false);
        expect(page.root.getAttribute(CoverAttribute)).toBe("opaque");
    });

    it("goes without a fade under reduced motion", async () => {
        const page = fakePage({ tokens: Tokens, reduced: true });
        await cover(page, false);
        expect(await (page.run(uncoverScript()) as Promise<string>)).toBe("ok");
        expect(page.animations).toHaveLength(0);
        expect(page.byId("mt-switch-cover")).toBeNull();
    });

    it("is taken off at once when its switch went elsewhere, and by itself when nothing else does", async () => {
        const page = fakePage({ tokens: Tokens });
        await cover(page, false);
        expect(page.timers).toHaveLength(1);
        page.run(removeCoverScript());
        expect(page.byId("mt-switch-cover")).toBeNull();
        expect(page.root.hasAttribute(CoverAttribute)).toBe(false);
        page.root.setAttribute(PictureAttribute, "blob:again");
        await cover(page, false);
        page.timers[1]();
        expect(page.byId("mt-switch-cover")).toBeNull();
        expect(page.root.hasAttribute(CoverAttribute)).toBe(false);
    });

    it("lets go of a cover its switch never took off within a few seconds, not the leaver's whole hold", async () => {
        const page = fakePage({ tokens: Tokens });
        await cover(page, false);
        expect(page.delays).toEqual([SwitchCoverMaxMs]);
        expect(SwitchCoverMaxMs).toBeLessThanOrEqual(3000);
        // long enough for a reinit (400 ms at most) and the wait for the panels
        expect(SwitchCoverMaxMs).toBeGreaterThan(400 + SwitchSettleMaxMs);
        expect(SwitchCoverMaxMs).toBeLessThan(SwitchHoldMaxMs);
    });

    it("counts each panel once, whatever the frames the page draws for it", async () => {
        const page = fakePage({ blocks: ["a", "a", "b", "b", "c"] });
        expect(await (page.run(settleProbeScript()) as Promise<SettleReport>)).toEqual({ blocks: 3, visible: true });
        const hidden = fakePage({ blocks: ["a"], visible: false });
        expect(await (hidden.run(settleProbeScript()) as Promise<SettleReport>)).toEqual({ blocks: 1, visible: false });
    });
});

type FakeView = SwitchView & {
    scripts: string[];
    sent: string[];
    live: boolean;
    answers: Record<string, unknown>;
};

function fakeView(id: string): FakeView {
    const v: FakeView = {
        id,
        scripts: [],
        sent: [],
        live: true,
        answers: {},
        isLive: () => v.live,
        // the pictures the view was sent, by the tab they show
        sendPicture: (picture: SwitchPicture) => {
            v.sent.push(picture.tabId);
        },
        run: (script: string) => {
            v.scripts.push(script);
            if (script === clearSwitchScript()) {
                return Promise.resolve(v.answers.clear ?? "clean");
            }
            // a page frozen mid-dissolve (a hidden page runs no animation frame) answers no probe and no dissolve
            if (v.answers.frozen && (script === uncoverScript() || script.startsWith("new Promise"))) {
                return new Promise(() => {});
            }
            if (script === prepareCoverScript()) {
                return Promise.resolve(v.answers.prepare ?? "ready");
            }
            const kind = script.startsWith("new Promise") ? "settle" : "other";
            return Promise.resolve(kind === "settle" ? (v.answers.settle ?? { blocks: 0, visible: true }) : "ok");
        },
    };
    return v;
}

const scriptsOf = (v: FakeView, what: string) => v.scripts.filter((s) => s.includes(what));

// A switch's wait that a test does not await (`void sw.arrived(...)`) polls on through the deps' timers, which read the
// global setTimeout each time they are called. Left running, it went on in the real clock once its test was over, and
// then in the fake clock of whichever test ran next, where it showed up as a timer that test never made: a count of
// pending timers failed on a loaded machine only, when a poll happened to land inside the later test (#2400). So a
// fixture is ended with its test, before the clock comes back, and what it left running goes quiet: its timers are inert.
const endFixtures: (() => void)[] = [];

function setup(over: Partial<SwitchPictureDeps> = {}, pictures: SwitchPicture[] = [pic("target", "wt", 1000)]) {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const store = new SwitchPictureStore();
    pictures.forEach((p) => store.put(p));
    const log: string[] = [];
    const held: [string, boolean][] = [];
    const captures: string[] = [];
    let ended = false;
    const end = () => {
        ended = true;
    };
    endFixtures.push(end);
    const deps: SwitchPictureDeps = {
        now: () => Date.now(),
        setTimer: (fn, ms) => (ended ? null : setTimeout(fn, ms)),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        log: (m) => log.push(m),
        enabled: () => true,
        store,
        translucent: () => false,
        letThrough: () => false,
        restoreLook: () => {},
        viewOfTab: () => null,
        windowSize: () => ({ width: 1000, height: 700 }),
        captureLeaver: (_v, tabId) => captures.push(tabId),
        holdKeys: (v, hold) => held.push([v.id, hold]),
        expectedBlocks: async () => 2,
        ...over,
    };
    const sw = new WindowSwitchPicture(deps);
    return { sw, deps, store, log, held, captures, end, leaver: fakeView("leaver"), target: fakeView("target") };
}

afterEach(() => {
    endFixtures.splice(0).forEach((end) => end());
    vi.useRealTimers();
});

describe("one window's switch", () => {
    it("shows the target's picture on the leaver at the action, takes the leaver's picture first, and holds its keys", () => {
        const { sw, leaver, held, captures } = setup();
        expect(sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" })).toBe(true);
        expect(captures).toEqual(["leaver"]);
        expect(held).toEqual([["leaver", true]]);
        expect(leaver.scripts).toHaveLength(1);
        // the picture's bytes go to the page first, the script that shows it second, and carries no picture itself
        expect(leaver.sent).toEqual(["target"]);
        expect(leaver.scripts[0]).toContain("mt-switch-overlay");
        expect(leaver.scripts[0].length).toBeLessThan(10000);
        expect(sw.isActive()).toBe(true);
    });

    it("shows nothing when the target has no picture, the window changed size or the setting is off", () => {
        for (const over of [
            { windowSize: () => ({ width: 1200, height: 700 }) },
            { enabled: () => false },
        ] as Partial<SwitchPictureDeps>[]) {
            const { sw, leaver } = setup(over);
            expect(sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" })).toBe(false);
            expect(leaver.scripts).toEqual([]);
            expect(sw.isActive()).toBe(false);
        }
        const none = setup({}, []);
        expect(none.sw.begin(none.leaver, "leaver", "wl", { workspaceId: "wt" })).toBe(false);
    });

    it("fades the leaver's own content out only when both it and the picture let the desktop through", () => {
        const both = setup({ translucent: () => true }, [pic("target", "wt", 1000, { translucent: true })]);
        both.sw.begin(both.leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(scriptsOf(both.leaver, "var m = true ?")).toHaveLength(1);
        const picOnly = setup({ translucent: () => false }, [pic("target", "wt", 1000, { translucent: true })]);
        picOnly.sw.begin(picOnly.leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(scriptsOf(picOnly.leaver, "var m = false ?")).toHaveLength(1);
        const opaque = setup({ translucent: () => true });
        opaque.sw.begin(opaque.leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(scriptsOf(opaque.leaver, "var m = false ?")).toHaveLength(1);
    });

    it("lets an opaque leaver through for a see-through target, so the look moves with the cross-fade (#2390)", () => {
        const through: string[] = [];
        const restored: string[] = [];
        const s = setup(
            {
                translucent: () => false,
                letThrough: (v) => {
                    through.push(v.id);
                    return true;
                },
                restoreLook: (v) => restored.push(v.id),
            },
            [pic("target", "wt", 1000, { translucent: true }), pic("other", "wo", 1100, { translucent: true })]
        );
        s.sw.begin(s.leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(through).toEqual(["leaver"]);
        expect(scriptsOf(s.leaver, "var m = true ?")).toHaveLength(1);
        // a newer switch keeps the overlay as it is: the leaver is not let through twice
        s.sw.begin(s.leaver, "leaver", "wl", { workspaceId: "wo" });
        expect(through).toEqual(["leaver"]);
        // the switch ends without a target: the leaver gets its own background back
        s.sw.cancel();
        expect(restored).toEqual(["leaver"]);
        // an opaque target's picture never clears the leaver
        const flat = setup({ letThrough: (v) => through.push(v.id) > 0 });
        flat.sw.begin(flat.leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(through).toEqual(["leaver"]);
        flat.sw.cancel();
    });
    it("tells the target to keep its own content out of sight only under a picture that lets the desktop through", async () => {
        const see = setup({}, [pic("target", "wt", 1000, { translucent: true })]);
        see.sw.begin(see.leaver, "leaver", "wl", { workspaceId: "wt" });
        await see.sw.cover(see.target, "target");
        await see.sw.attach(see.target);
        expect(see.target.scripts).toContain(attachCoverScript(true));
        expect(scriptsOf(see.target, `"${CoverHidesRoot}"`)).toHaveLength(1);
        const flat = setup();
        flat.sw.begin(flat.leaver, "leaver", "wl", { workspaceId: "wt" });
        await flat.sw.cover(flat.target, "target");
        await flat.sw.attach(flat.target);
        expect(flat.target.scripts).toContain(attachCoverScript(false));
        expect(scriptsOf(flat.target, `"${CoverHidesRoot}"`)).toHaveLength(0);
    });

    it("puts the picture on the target only once its page has it decoded", async () => {
        const { sw, leaver, target } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(await sw.attach(target)).toBe(false);
        expect(target.scripts).toEqual([]);
        target.answers.prepare = "undecoded";
        expect(await sw.cover(target, "target")).toBe(false);
        expect(await sw.attach(target)).toBe(false);
        expect(target.scripts).toEqual([prepareCoverScript()]);
        target.answers.prepare = "ready";
        expect(await sw.cover(target, "target")).toBe(true);
        expect(await sw.attach(target)).toBe(true);
    });

    it("does not show a picture of the view being left, nor leave a destroyed view", () => {
        const { sw, leaver } = setup();
        expect(sw.begin(leaver, "target", "wt", { workspaceId: "wt" })).toBe(false);
        leaver.live = false;
        expect(sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" })).toBe(false);
    });

    it("covers the target only with its own picture, before it is shown", async () => {
        const { sw, leaver, target } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(await sw.cover(target, "target")).toBe(true);
        expect(target.scripts).toEqual([prepareCoverScript()]);
        expect(await sw.attach(target)).toBe(true);
        expect(scriptsOf(target, "mt-switch-cover")).toHaveLength(2);
        const other = fakeView("elsewhere");
        expect(await sw.cover(other, "elsewhere")).toBe(false);
        expect(other.scripts).toEqual([]);
        expect(sw.isActive()).toBe(false);
    });

    it("puts the leaver back and the picture away when the switch cannot cover", async () => {
        const { sw, leaver, target, held } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        target.run = () => Promise.reject(new Error("the page is gone"));
        expect(await sw.cover(target, "target")).toBe(false);
        expect(sw.isActive()).toBe(false);
        expect(held[held.length - 1]).toEqual(["leaver", false]);
    });

    it("lets the target arrive at once: the leaver's overlay goes and its keys are free before any panel is waited for", () => {
        const { sw, leaver, target, held } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        void sw.arrived(target, "target");
        expect(sw.isActive()).toBe(false);
        expect(held).toEqual([
            ["leaver", true],
            ["leaver", false],
        ]);
        expect(scriptsOf(leaver, "mt-switch-overlay").length).toBeGreaterThan(1);
    });

    it("dissolves the cover once every panel is mounted, with no fixed wait", async () => {
        const { sw, leaver, target } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        target.answers.settle = { blocks: 2, visible: true };
        const done = sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(0);
        await done;
        expect(scriptsOf(target, "function count()")).toHaveLength(1);
        expect(scriptsOf(target, "fade(c, 1, 0, dissolveMs")).toHaveLength(1);
    });

    it("leaves a newer switch's cover alone when an older switch's wait for the same view ends (A to B, B to A, A to B)", async () => {
        const { sw, leaver, target } = setup();
        // switch 1 lands on B and waits for its panels, which never all come
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        target.answers.settle = { blocks: 0, visible: true };
        const first = sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(SwitchSettlePollMs);
        // switch 3 goes to B again while that wait goes on, and puts its own cover on
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        await sw.attach(target);
        const scriptsBefore = target.scripts.length;
        await vi.advanceTimersByTimeAsync(SwitchSettleMaxMs + SwitchSettlePollMs);
        await first;
        // the first wait ended without touching it: no dissolve, and the cover is still the switch's
        expect(target.scripts.slice(scriptsBefore).filter((s) => s === uncoverScript())).toHaveLength(0);
        expect(target.scripts.filter((s) => s === uncoverScript())).toHaveLength(0);
        expect(sw.isPreparedAhead(target, "target")).toBe(false);
        // the third switch lands and takes its own cover off, once
        target.answers.settle = { blocks: 2, visible: true };
        const third = sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(SwitchSettlePollMs);
        await third;
        expect(target.scripts.filter((s) => s === uncoverScript())).toHaveLength(1);
    });

    it("keeps looking while panels mount, and lets the picture go anyway after SwitchSettleMaxMs", async () => {
        const { sw, leaver, target, log } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        target.answers.settle = { blocks: 0, visible: true };
        const done = sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(SwitchSettleMaxMs + SwitchSettlePollMs);
        await done;
        const probes = target.scripts.filter((s) => s.startsWith("new Promise")).length;
        expect(probes).toBeGreaterThan(3);
        expect(probes).toBeLessThanOrEqual(Math.ceil(SwitchSettleMaxMs / SwitchSettlePollMs) + 1);
        expect(scriptsOf(target, "fade(c, 1, 0, dissolveMs")).toHaveLength(1);
        expect(log.some((m) => m.includes("anyway"))).toBe(true);
    });

    it("stops looking when the target's page is gone", async () => {
        const { sw, leaver, target } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        target.live = false;
        const done = sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(10);
        await done;
        expect(target.scripts).toEqual([]);
    });

    it("fades the picture out and frees the keys when the switch ends without a target", () => {
        const { sw, leaver, held } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        sw.cancel();
        expect(sw.isActive()).toBe(false);
        expect(held[held.length - 1]).toEqual(["leaver", false]);
        expect(leaver.scripts[leaver.scripts.length - 1]).toContain("fade(ov, 1, 0, dissolveMs");
    });

    it("lets a picture go by itself when its action died without a word", () => {
        const { sw, leaver, held } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        vi.advanceTimersByTime(SwitchHoldMaxMs + 1);
        expect(sw.isActive()).toBe(false);
        expect(held[held.length - 1]).toEqual(["leaver", false]);
    });

    it("keeps the screen on a picture, never back on the view left, when a newer switch has none", () => {
        const { sw, leaver } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(sw.begin(leaver, "leaver", "wl", { workspaceId: "nobody" })).toBe(false);
        expect(sw.isActive()).toBe(true);
    });

    it("changes the picture of a newer switch, takes the cover off a target it no longer goes to, and captures the leaver once", async () => {
        const second = pic("second", "ws", 2000);
        const { sw, leaver, target, captures } = setup({}, [pic("target", "wt", 1000), second]);
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        expect(sw.begin(leaver, "leaver", "wl", { workspaceId: "ws" })).toBe(true);
        expect(target.scripts.filter((s) => s === removeCoverScript())).toHaveLength(1);
        expect(leaver.sent).toEqual(["target", "second"]);
        expect(captures).toEqual(["leaver"]);
    });

    it("arms a picture ahead of the click, only when nothing else shows and the target is not the view itself", () => {
        const { sw, leaver } = setup();
        sw.arm(leaver, { workspaceId: "wt" });
        expect(scriptsOf(leaver, "__mtSwitchArmed")).toHaveLength(1);
        sw.arm(leaver, { workspaceId: "nobody" });
        sw.arm(fakeView("target"), { workspaceId: "wt" });
        expect(leaver.scripts).toHaveLength(1);
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        const before = leaver.scripts.length;
        sw.arm(leaver, { workspaceId: "wt" });
        expect(leaver.scripts).toHaveLength(before);
    });

    it("reads the view on screen back on the intent, so the click has nothing left to read while the target reinitializes", () => {
        const { sw, leaver, captures } = setup();
        sw.arm(leaver, { workspaceId: "wt" }, "wl");
        expect(captures).toEqual(["leaver"]);
        const nobody = setup();
        nobody.sw.arm(nobody.leaver, { workspaceId: "nobody" }, "wl");
        expect(nobody.captures).toEqual(["leaver"]);
        const off = setup({ enabled: () => false });
        off.sw.arm(off.leaver, { workspaceId: "wt" }, "wl");
        expect(off.captures).toEqual([]);
        // a switch under way already holds the leaver's overlay: it is not read back again
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        sw.arm(leaver, { workspaceId: "wt" }, "wl");
        expect(captures).toEqual(["leaver", "leaver"]);
    });

    it("hands a picture to a page once: a pointer crossing the dots, then the click, send it a single time", () => {
        const { sw, leaver } = setup();
        sw.arm(leaver, { workspaceId: "wt" });
        sw.arm(leaver, { workspaceId: "wt" });
        sw.arm(leaver, { tabId: "target" });
        expect(leaver.sent).toEqual(["target"]);
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(leaver.sent).toEqual(["target"]);
    });

    it("hands a picture again once the page let it go, or after it has been held too long", () => {
        const { sw, leaver, target } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        void sw.arrived(target, "target");
        sw.arm(leaver, { workspaceId: "wt" });
        expect(leaver.sent).toEqual(["target", "target"]);
        vi.advanceTimersByTime(SwitchArmedMs + 1);
        sw.arm(leaver, { workspaceId: "wt" });
        expect(leaver.sent).toEqual(["target", "target", "target"]);
    });

    it("also hands the picture to the target's own warm view ahead of the click and has it decode its cover there", async () => {
        const target = fakeView("target");
        const { sw, leaver } = setup({ viewOfTab: (tabId) => (tabId === "target" ? target : null) });
        sw.arm(leaver, { workspaceId: "wt" });
        expect(target.sent).toEqual(["target"]);
        expect(target.scripts).toEqual([prepareCoverScript()]);
        expect(scriptsOf(leaver, "__mtSwitchArmed")).toHaveLength(1);
        await Promise.resolve();
        // the click and the cover then send and run nothing in the target, which is busy with its reinit
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        expect(await sw.cover(target, "target")).toBe(true);
        expect(target.sent).toEqual(["target"]);
        expect(target.scripts).toEqual([prepareCoverScript()]);
        expect(leaver.sent).toEqual(["target"]);
        expect(await sw.attach(target)).toBe(true);
        expect(target.scripts).toEqual([prepareCoverScript(), attachCoverScript(false)]);
    });

    it("prepares the cover at the click when the page was not ready ahead of it", async () => {
        const target = fakeView("target");
        target.answers.prepare = "undecoded";
        const { sw, leaver } = setup({ viewOfTab: (tabId) => (tabId === "target" ? target : null) });
        sw.arm(leaver, { workspaceId: "wt" });
        await Promise.resolve();
        await Promise.resolve();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        target.answers.prepare = "ready";
        expect(await sw.cover(target, "target")).toBe(true);
        expect(target.scripts).toEqual([prepareCoverScript(), prepareCoverScript()]);
        expect(target.sent).toEqual(["target"]);
    });

    it("does not count a page as prepared once it gave its cover up", async () => {
        const target = fakeView("target");
        const { sw, leaver } = setup({ viewOfTab: (tabId) => (tabId === "target" ? target : null) });
        sw.arm(leaver, { workspaceId: "wt" });
        await Promise.resolve();
        await Promise.resolve();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        sw.giveUpCover(target);
        expect(await sw.cover(target, "target")).toBe(true);
        expect(target.sent).toEqual(["target", "target"]);
        expect(target.scripts.filter((s) => s === prepareCoverScript())).toHaveLength(2);
    });

    it("gives a cover up: the page is told, and the cover is not waited for again", async () => {
        const { sw, leaver, target } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        sw.giveUpCover(target);
        expect(target.scripts[target.scripts.length - 1]).toBe(giveUpCoverScript());
        void sw.arrived(target, "target");
        expect(target.scripts.filter((s) => s === removeCoverScript())).toHaveLength(0);
    });

    it("draws the wait over the picture and takes it away", () => {
        const { sw, leaver } = setup();
        sw.showWaiting({ phase: "loading", name: "n", caption: "c" });
        expect(leaver.scripts).toEqual([]);
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        sw.showWaiting({ phase: "loading", name: "n", caption: "c" });
        sw.showWaiting(null);
        expect(scriptsOf(leaver, "mt-switch-wait").length).toBeGreaterThanOrEqual(2);
    });

    it("goes quiet with its test: a wait nobody awaited sets no timer once its fixture has ended (#2400)", async () => {
        const { sw, leaver, target, end } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        target.answers.settle = { blocks: 0, visible: true };
        void sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(0);
        // the wait has probed once and holds its poll timer, the switch its last word's timer
        const held = vi.getTimerCount();
        expect(held).toBe(2);
        // what afterEach does before the clock comes back
        end();
        await vi.advanceTimersByTimeAsync(SwitchSettlePollMs);
        // the poll fired and was not replaced: nothing of this test goes on in a clock that is another test's
        expect(vi.getTimerCount()).toBe(held - 1);
    });
});

describe("typing arms nothing, and a closed tab leaves no picture (#2375)", () => {
    const source = (path: string) => readFileSync(path, "utf8");

    it("keeps every key hook of the tab view away from the switch picture: Option types { } [ ] | ~ and terminals take Alt as Meta", () => {
        expect(source("emain/emain-tabview.ts")).not.toContain("moltenterm-switch-picture");
        const live = source("emain/moltenterm-switch-picture-live.ts");
        expect(live).not.toContain("noteSwitchModifier");
        expect(live).not.toMatch(/input\.key\s*[!=]==?\s*"Alt"/);
    });

    it("arms only from the intent of a dot, which is a dwell of the pointer", () => {
        const live = source("emain/moltenterm-switch-picture-live.ts");
        expect(live.match(/\.arm\(/g)).toHaveLength(1);
        expect(live).toContain("onAppIpc(SwitchIntentChannel");
        expect(source("frontend/moltenterm-shell/sidebar/sidebar-switch.ts")).toContain("makeSwitchIntent(");
    });

    it("asks the backend which of the pictures' tabs are left each time the views of deleted tabs are swept", () => {
        const host = source("emain/moltenterm-tabview-host.ts");
        const sweep = host.slice(host.indexOf("export function sweepDeletedTabViews"));
        expect(sweep.slice(0, sweep.indexOf("\n}\n"))).toContain("pruneDeletedSwitchPictures();");
    });
});

describe("a switch that shows its remembered layout shows no picture (#2407)", () => {
    const source = (path: string) => readFileSync(path, "utf8");

    it("takes the layout only for the very next switch to the marked workspace, a moment after the mark", () => {
        const mark = { workspaceId: "ws-b", at: 1000 };
        expect(takesLayout(mark, { workspaceId: "ws-b" }, 1010)).toBe(true);
        expect(takesLayout(mark, { workspaceId: "ws-c" }, 1010)).toBe(false);
        expect(takesLayout(mark, { tabId: "tab-1" }, 1010)).toBe(false);
        expect(takesLayout(mark, { workspaceId: "ws-b" }, 1000 + LayoutSwitchMaxMs)).toBe(false);
        expect(takesLayout(null, { workspaceId: "ws-b" }, 1010)).toBe(false);
    });

    it("is marked by the sidebar on the intent channel, before it asks the switch, and lets the page know it is on screen", () => {
        const live = source("emain/moltenterm-switch-picture-live.ts");
        expect(live).toContain("layoutSwitches.set(win");
        expect(live).toContain("takesLayout(marked, target");
        expect(live).toContain("__mtSwitchLayoutOnScreen");
        const sidebar = source("frontend/moltenterm-shell/sidebar/sidebar-switch.ts");
        expect(sidebar.indexOf("layout: true })")).toBeGreaterThan(0);
        expect(sidebar.indexOf("layout: true })")).toBeLessThan(sidebar.indexOf("getApi().switchWorkspace(workspaceId)"));
        expect(source("frontend/moltenterm-shell/switch-layout/layout-frames.ts")).toContain(
            "__mtSwitchLayoutOnScreen = arrivedOnScreen"
        );
    });

    it("answers the view that asked a sidebar switch it did not make here, whatever path ended it", () => {
        const win = source("emain/emain-window.ts");
        const handler = win.slice(win.indexOf('onAppIpc("switch-workspace"'));
        const body = handler.slice(0, handler.indexOf("\n});\n"));
        // in a finally: a switch cancelled, sent to another window or failed answers too
        expect(body).toMatch(/finally \{\s*answerSidebarSwitch\(ww, workspaceId, event\.sender\.id\)/);
        const live = source("emain/moltenterm-switch-picture-live.ts");
        const answer = live.slice(live.indexOf("export function answerSidebarSwitch"));
        expect(answer.slice(0, answer.indexOf("\n}\n"))).toMatch(/win\.workspaceId === workspaceId/);
        expect(live).toContain("__mtSwitchLayoutRefused");
        expect(source("frontend/moltenterm-shell/switch-layout/layout-frames.ts")).toContain(
            "__mtSwitchLayoutRefused = switchRefused"
        );
    });
});

// A switch's new view with no picture to wear is never shown half-drawn (#2390).
describe("a new view without a picture waits for its panels", () => {
    function clock(counts: number[]) {
        let t = 0;
        let i = 0;
        return {
            now: () => t,
            sleep: async (ms: number) => {
                t += ms;
            },
            count: async () => counts[Math.min(i++, counts.length - 1)],
            asked: () => i,
        };
    }

    it("is shown as soon as every panel of its tab is mounted", async () => {
        const c = clock([0, 1, 3]);
        expect(await waitPanelsMounted(c.count, 3, c.now, c.sleep)).toBe(true);
        expect(c.asked()).toBe(3);
    });

    it("takes a count that stopped changing for a layout that draws only some of its panels", async () => {
        const c = clock([0, 2, 2, 2, 2]);
        expect(await waitPanelsMounted(c.count, 5, c.now, c.sleep)).toBe(true);
        expect(c.asked()).toBe(2 + StableProbes);
    });

    it("never holds the switch longer than its bound, whatever the page answers", async () => {
        for (const counts of [[0], [-1]]) {
            const c = clock(counts);
            expect(await waitPanelsMounted(c.count, 3, c.now, c.sleep)).toBe(false);
            expect(c.now()).toBeGreaterThanOrEqual(PanelsMountMaxMs);
            expect(c.now()).toBeLessThan(PanelsMountMaxMs + 100);
        }
        const failing = clock([0]);
        const broken = () => Promise.reject(new Error("gone"));
        expect(await waitPanelsMounted(broken, 3, failing.now, failing.sleep)).toBe(false);
    });

    it("shows the view anyway when the page or the backend never answers: one real deadline for the whole wait", async () => {
        vi.useFakeTimers();
        // The deadlines' own timers, counted here: the clock's count (vi.getTimerCount) holds whatever any other code
        // schedules while it is faked, which is not what this test is about (#2400).
        const pending = new Set<unknown>();
        const set = (fn: () => void, ms: number) => {
            const handle = setTimeout(() => {
                pending.delete(handle);
                fn();
            }, ms);
            pending.add(handle);
            return handle;
        };
        const clear = (h: unknown) => {
            pending.delete(h);
            clearTimeout(h as ReturnType<typeof setTimeout>);
        };
        // a renderer locked up after its first render: the probe never comes back
        const hung = waitPanelsMounted(() => new Promise<number>(() => {}), 3, () => Date.now(), (ms) =>
            new Promise<void>((r) => setTimeout(r, ms))
        );
        let shown: boolean = null;
        void withDeadline(hung, PanelsMountMaxMs, false, set, clear).then((v) => (shown = v));
        await vi.advanceTimersByTimeAsync(PanelsMountMaxMs - 1);
        expect(shown).toBeNull();
        await vi.advanceTimersByTimeAsync(2);
        expect(shown).toBe(false);
        expect(pending.size).toBe(0);
        // an answer in time wins and leaves no timer behind
        expect(await withDeadline(Promise.resolve(true), PanelsMountMaxMs, false, set, clear)).toBe(true);
        expect(pending.size).toBe(0);
        expect(await withDeadline(Promise.reject(new Error("gone")), PanelsMountMaxMs, false, set, clear)).toBe(false);
        expect(pending.size).toBe(0);
        const live = readFileSync("emain/moltenterm-switch-picture-live.ts", "utf8");
        const wait = live.slice(live.indexOf("export async function awaitArrivingPanels"));
        const body = wait.slice(0, wait.indexOf("\n}\n"));
        expect(body.indexOf("withDeadline(")).toBeLessThan(body.indexOf("ObjectService.GetObject"));
        expect(body.indexOf("withDeadline(")).toBeLessThan(body.indexOf("executeJavaScript"));
    });

    it("reads the panels from the page's DOM, which a view off screen keeps up to date", () => {
        const page = fakePage({ blocks: ["a", "a", "b"] });
        expect(page.run(mountedBlocksScript())).toBe(2);
        expect(mountedBlocksScript()).not.toContain("requestAnimationFrame");
    });

    it("is waited for only on a switch's new view that wears no picture", () => {
        const host = readFileSync("emain/moltenterm-tabview-host.ts", "utf8");
        const init = host.slice(host.indexOf("async function initializeTab"));
        const body = init.slice(0, init.indexOf("\n}\n"));
        expect(body.indexOf("awaitArrivingPanels")).toBeGreaterThan(body.indexOf("await coverGrace"));
        expect(body).toContain("offScreen && !nothingShown");
        const live = readFileSync("emain/moltenterm-switch-picture-live.ts", "utf8");
        const wait = live.slice(live.indexOf("export async function awaitArrivingPanels"));
        expect(wait.slice(0, wait.indexOf("\n}\n"))).toContain(".wears(adapterOf(view))");
    });
});

// The gold froze on 2026-11-19 (#2390): a picture whose decode ended after its switch had landed went on over the view
// left, for good, taking its clicks; the developer found it over the live view when they came back to it.
describe("no picture outlives its switch (#2390)", () => {
    const Tokens = { "--mt-duration-base": "180ms", "--mt-duration-fast": "120ms", "--mt-ease": "ease" };

    it("never puts on a picture whose decode ends after its removal", async () => {
        const page = fakePage({ tokens: Tokens, withMain: true, slowDecode: true });
        page.run(showPictureScript(true));
        await flush();
        // the switch lands before the page has decoded the picture: the removal finds nothing
        expect(page.run(removeOverlayScript(false))).toBe("none");
        page.releaseDecodes();
        await flush();
        expect(page.byId("mt-switch-overlay")).toBeNull();
        expect(page.byId("main").style.opacity).toBeUndefined();
        expect(page.animations).toHaveLength(0);
    });

    it("lets only the newest of two pictures still decoding go on", async () => {
        const page = fakePage({ tokens: Tokens, slowDecode: true, picture: "blob:first" });
        page.run(showPictureScript(false));
        await flush();
        page.root.setAttribute(PictureAttribute, "blob:second");
        page.run(showPictureScript(false));
        await flush();
        page.releaseDecodes();
        await flush();
        expect(page.byId("mt-switch-overlay").children.map((c) => c.src)).toEqual(["blob:second"]);
    });

    it("clears, without a fade, whatever a page frozen mid-dissolve still holds", async () => {
        const page = fakePage({ tokens: Tokens, withMain: true });
        (page.body.style as any).background = "rgb(1, 2, 3)";
        page.run(showPictureScript(true));
        await flush();
        page.root.setAttribute(PictureAttribute, "blob:cover");
        await (page.run(prepareCoverScript()) as Promise<unknown>);
        page.run(attachCoverScript(true));
        expect(page.byId("mt-switch-cover")).not.toBeNull();
        // the dissolve starts and its animation never runs: the cover and the hidden content stay
        page.run(uncoverScript());
        expect(page.run(clearSwitchScript())).toBe("overlay,cover,content-hidden");
        expect(page.byId("mt-switch-overlay")).toBeNull();
        expect(page.byId("mt-switch-cover")).toBeNull();
        expect(page.root.hasAttribute(CoverAttribute)).toBe(false);
        expect(page.byId("main").style.opacity).toBe("");
        expect((page.body.style as any).background).toBe("rgb(1, 2, 3)");
        expect(page.run(clearSwitchScript())).toBe("clean");
    });

    it("has main clear a target frozen mid-dissolve and the view left, about a second after the switch", async () => {
        const { sw, leaver, target, log } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        await sw.attach(target);
        target.answers.frozen = true;
        target.answers.clear = "cover,content-hidden";
        leaver.answers.clear = "overlay";
        void sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(SwitchClearAfterMs - 10);
        expect(target.scripts.filter((s) => s === clearSwitchScript())).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(20);
        expect(target.scripts.filter((s) => s === clearSwitchScript())).toHaveLength(1);
        expect(leaver.scripts.filter((s) => s === clearSwitchScript())).toHaveLength(1);
        expect(log.some((m) => m.includes("forced off what target still held (cover,content-hidden)"))).toBe(true);
        expect(log.some((m) => m.includes("forced off what leaver still held (overlay)"))).toBe(true);
        expect(log.some((m) => m.includes("did not answer the dissolve"))).toBe(true);
        // the frozen settle, should the page ever answer, takes nothing off any more
        await vi.advanceTimersByTimeAsync(5000);
        expect(scriptsOf(target, "fade(c, 1, 0, dissolveMs")).toHaveLength(1);
    });

    it("clears a switch that ended without its target, and logs nothing for a page that held nothing", async () => {
        const { sw, leaver, log } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        sw.cancel();
        await vi.advanceTimersByTimeAsync(SwitchClearAfterMs + 10);
        expect(leaver.scripts.filter((s) => s === clearSwitchScript())).toHaveLength(1);
        expect(log.some((m) => m.includes("forced off"))).toBe(false);
    });

    it("leaves alone a view a newer switch is using", async () => {
        const { sw, leaver, target } = setup({}, [pic("target", "wt", 1000), pic("leaver", "wl", 900)]);
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        await sw.cover(target, "target");
        void sw.arrived(target, "target");
        await vi.advanceTimersByTimeAsync(100);
        // straight back: the target is now the view being left, its overlay belongs to the new switch
        sw.begin(target, "target", "wt", { workspaceId: "wl" });
        await vi.advanceTimersByTimeAsync(SwitchClearAfterMs);
        expect(target.scripts.filter((s) => s === clearSwitchScript())).toHaveLength(0);
    });

    it("reports a page that does not answer main's last word", async () => {
        const { sw, leaver, log } = setup();
        sw.begin(leaver, "leaver", "wl", { workspaceId: "wt" });
        const run = leaver.run;
        leaver.run = (s: string) => (s === clearSwitchScript() ? new Promise(() => {}) : run(s));
        sw.cancel();
        await vi.advanceTimersByTimeAsync(SwitchClearAfterMs + 1100);
        expect(log.some((m) => m.includes("leaver did not answer the last clear"))).toBe(true);
    });
});
