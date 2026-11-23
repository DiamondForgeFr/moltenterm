// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { setSectionUnfolded } from "./companion-arrange-model";
import {
    BlockBarPx,
    BlockCappedAttr,
    BlockCapPx,
    BlockFadePx,
    blockHeight,
    BlockMeasure,
    BlockProbeAttr,
    capFoot,
    capState,
    followBlockCap,
    hiddenRowCount,
    isTall,
    makeBlockCapValue,
    measureBlock,
    NoCap,
    watchBlockCap,
} from "./companion-block-cap";
import { FlowBlock, flowLayout, FlowResult } from "./companion-flow-model";
import { FlowWatchEnv } from "./companion-flow-watch";
import { CompanionSectionIds, DefaultCompanionLayout, isUnfolded } from "./companion-layout";

// A block as the page lays it out, as far as the cap is concerned. Its content is NaturalHeight tall; the stylesheet
// (companion-dashboard.css) clamps the section to the cap only while it carries data-capped and is not measured, and the
// bar (rendered once the block is tall) is lifted out of the measure with data-probe.
const RowsSelector = ".row";
const RowHeight = 40;
const Head = 60;
// What the body leaves above the bar and the block's padding, once it is clamped.
const ClampedBodyBottom = BlockCapPx - BlockBarPx - 12;

class FakeSection {
    attrs = new Set<string>();
    natural = 0;
    setAttribute(name: string) {
        this.attrs.add(name);
    }
    removeAttribute(name: string) {
        this.attrs.delete(name);
    }
    hasAttribute(name: string) {
        return this.attrs.has(name);
    }
    get offsetHeight() {
        if (this.attrs.has(BlockProbeAttr)) {
            return this.natural;
        }
        return this.attrs.has(BlockCappedAttr) ? Math.min(this.natural, BlockCapPx) : this.natural;
    }
}

class FakeBody {
    rows = 0;
    children: object[] = [];
    getBoundingClientRect() {
        return { bottom: ClampedBodyBottom };
    }
    querySelectorAll(selector: string) {
        expect(selector).toBe(RowsSelector);
        return Array.from({ length: this.rows }, (_, i) => ({
            getBoundingClientRect: () => ({ bottom: Head + (i + 1) * RowHeight }),
        }));
    }
}

function fakeEnv() {
    const resize: FakeResize[] = [];
    const mutation: FakeMutation[] = [];
    class FakeResize {
        callback: () => void;
        watched = new Set<object>();
        constructor(callback: () => void) {
            this.callback = callback;
            resize.push(this);
        }
        observe(el: object) {
            this.watched.add(el);
        }
        unobserve(el: object) {
            this.watched.delete(el);
        }
        disconnect() {
            this.watched.clear();
        }
    }
    class FakeMutation {
        callback: () => void;
        target: object = null;
        options: MutationObserverInit = null;
        constructor(callback: () => void) {
            this.callback = callback;
            mutation.push(this);
        }
        observe(target: object, options: MutationObserverInit) {
            this.target = target;
            this.options = options;
        }
        disconnect() {
            this.target = null;
        }
    }
    const env = { ResizeObserver: FakeResize, MutationObserver: FakeMutation } as unknown as FlowWatchEnv;
    return { env, resize, mutation };
}

// A block in a page, followed as the dashboard follows it: what measuring says is what the block is drawn as (a bar, the
// clamp and the fade), and a block drawn differently is measured again, as the layout effect does. A content that changes
// is observed by the page's observers, which the tests call.
function mountBlock(natural: number, rows = 0, unfolded = false) {
    const section = new FakeSection();
    const body = new FakeBody();
    section.natural = natural;
    body.rows = rows;
    const fake = fakeEnv();
    const page = { measure: NoCap as BlockMeasure, unfolded, draws: 0 };
    const draw = () => {
        const state = capState(page.measure, page.unfolded);
        if (state.capped) {
            section.setAttribute(BlockCappedAttr);
        } else {
            section.removeAttribute(BlockCappedAttr);
        }
        page.draws++;
    };
    const follow = followBlockCap(
        section as unknown as HTMLElement,
        body as unknown as HTMLElement,
        RowsSelector,
        (next) => {
            page.measure = next;
            draw();
            follow.measure();
        },
        fake.env
    );
    follow.measure();
    return {
        section,
        body,
        page,
        follow,
        fake,
        // The block as the developer sees it.
        bar: () => (page.measure.tall ? capFoot(page.unfolded, page.measure.hidden) : null),
        fade: () => section.hasAttribute(BlockCappedAttr),
        height: () => section.offsetHeight,
        // The content changes: the page's observers tell the block.
        setContent(next: number, nextRows = body.rows) {
            section.natural = next;
            body.rows = nextRows;
            fake.resize[0].callback();
        },
        setUnfolded(next: boolean) {
            page.unfolded = next;
            draw();
            follow.measure();
        },
    };
}

describe("the cap on a block's height (#2477)", () => {
    it("is 500 px, with a 90 px fade and a 34 px bar", () => {
        expect(BlockCapPx).toBe(500);
        expect(BlockFadePx).toBe(90);
        expect(BlockBarPx).toBe(34);
    });

    it("takes a block taller than the cap for tall, and a block of the cap's height for short", () => {
        expect(isTall(0)).toBe(false);
        expect(isTall(499)).toBe(false);
        expect(isTall(500)).toBe(false);
        expect(isTall(501)).toBe(true);
    });

    it("gives the flow the block's own height, to the cap while it is folded and never above its content", () => {
        expect(blockHeight(0, false)).toBe(0);
        expect(blockHeight(128, false)).toBe(128);
        expect(blockHeight(499, false)).toBe(499);
        expect(blockHeight(500, false)).toBe(500);
        expect(blockHeight(501, false)).toBe(500);
        expect(blockHeight(1400, false)).toBe(500);
        expect(blockHeight(1400, true)).toBe(1400);
        // Unfolding a short block changes nothing: the cap is a maximum, never a minimum.
        expect(blockHeight(128, true)).toBe(128);
    });

    it("counts the rows the cap hides: those that end below the body's edge, a rounding pixel aside", () => {
        const bottoms = [100, 200, 300, 400, 500];
        expect(hiddenRowCount(bottoms, 1000)).toBe(0);
        expect(hiddenRowCount(bottoms, 400)).toBe(1);
        expect(hiddenRowCount(bottoms, 399)).toBe(1);
        expect(hiddenRowCount(bottoms, 398)).toBe(2);
        expect(hiddenRowCount(bottoms, 50)).toBe(5);
        expect(hiddenRowCount(bottoms, 400.5)).toBe(1);
        expect(hiddenRowCount([], 0)).toBe(0);
    });

    it("says what the bar reads: how many are hidden, 'Show all' alone without rows to count, 'Show less' once open", () => {
        expect(capFoot(false, 18)).toEqual({ labelKey: "companion.block.showAllMore", count: 18, chevron: "down" });
        expect(capFoot(false, 1)).toEqual({ labelKey: "companion.block.showAllMore", count: 1, chevron: "down" });
        expect(capFoot(false, 0)).toEqual({ labelKey: "companion.block.showAll", chevron: "down" });
        expect(capFoot(true, 18)).toEqual({ labelKey: "companion.block.showLess", chevron: "up" });
        expect(capFoot(true, 0)).toEqual({ labelKey: "companion.block.showLess", chevron: "up" });
    });

    it("folds a block that is tall, unfolds it on the developer's say, and leaves a short block alone", () => {
        expect(capState({ tall: true, hidden: 3 }, false)).toEqual({ capped: true, open: false });
        expect(capState({ tall: true, hidden: 3 }, true)).toEqual({ capped: false, open: true });
        expect(capState({ tall: false, hidden: 0 }, false)).toEqual({ capped: false, open: false });
        // Unfolded in the layout, short in the page: nothing shows, neither "Show less" nor a clamp.
        expect(capState({ tall: false, hidden: 0 }, true)).toEqual({ capped: false, open: false });
    });
});

describe("500 px is a maximum, never a size (#2477)", () => {
    it("leaves a short block its natural height, with no bar and no fade", () => {
        for (const natural of [0, 90, 128, 343, 499, 500]) {
            const block = mountBlock(natural, 4);
            expect(block.height(), `${natural}`).toBe(natural);
            expect(block.bar(), `${natural}`).toBeNull();
            expect(block.fade(), `${natural}`).toBe(false);
            expect(block.section.attrs.size, `${natural}`).toBe(0);
        }
    });

    it("never stretches a short block that is unfolded: no 'Show less', its natural height", () => {
        const block = mountBlock(180, 4);
        block.setUnfolded(true);
        expect(block.height()).toBe(180);
        expect(block.bar()).toBeNull();
        expect(block.fade()).toBe(false);
    });

    it("gives the bar and the fade once its content grows past the cap, and the cap as its height", () => {
        const block = mountBlock(320, 6);
        expect(block.bar()).toBeNull();
        block.setContent(900, 20);
        expect(block.bar()).toEqual({
            labelKey: "companion.block.showAllMore",
            count: expect.any(Number),
            chevron: "down",
        });
        expect(block.fade()).toBe(true);
        expect(block.height()).toBe(BlockCapPx);
        // One pixel past the cap is enough, the block still stops at it.
        const edge = mountBlock(500, 3);
        expect(edge.bar()).toBeNull();
        edge.setContent(501, 3);
        expect(edge.bar()).not.toBeNull();
        expect(edge.height()).toBe(BlockCapPx);
    });

    it("loses the bar and the fade, and gets its natural height back, once its content shrinks under the cap", () => {
        const block = mountBlock(900, 20);
        expect(block.bar()).not.toBeNull();
        expect(block.height()).toBe(BlockCapPx);
        // The files are committed: the block is what its content is again.
        block.setContent(450, 9);
        expect(block.bar()).toBeNull();
        expect(block.fade()).toBe(false);
        expect(block.height()).toBe(450);
        expect(block.section.attrs.size).toBe(0);
        block.setContent(120, 2);
        expect(block.height()).toBe(120);
        // And it grows past the cap again.
        block.setContent(700, 15);
        expect(block.bar()).not.toBeNull();
        expect(block.height()).toBe(BlockCapPx);
    });

    it("shows 'Show less' on an unfolded block that overflows the cap, and nowhere else", () => {
        const block = mountBlock(1400, 29, true);
        expect(block.bar()).toEqual({ labelKey: "companion.block.showLess", chevron: "up" });
        expect(block.fade()).toBe(false);
        expect(block.height()).toBe(1400);
        // Its content shrinks back under the cap: it stays unfolded in the layout, and shows neither a bar nor a clamp.
        block.setContent(460, 8);
        expect(block.bar()).toBeNull();
        expect(block.height()).toBe(460);
        // Grown again, it is still unfolded.
        block.setContent(800, 14);
        expect(block.bar()).toEqual({ labelKey: "companion.block.showLess", chevron: "up" });
        expect(block.height()).toBe(800);
    });

    it("folds an unfolded block back to the cap and unfolds it again", () => {
        const block = mountBlock(1400, 29);
        expect(block.height()).toBe(BlockCapPx);
        block.setUnfolded(true);
        expect(block.height()).toBe(1400);
        expect(block.bar().labelKey).toBe("companion.block.showLess");
        block.setUnfolded(false);
        expect(block.height()).toBe(BlockCapPx);
        expect(block.bar().labelKey).toBe("companion.block.showAllMore");
    });

    it("counts what the cap hides in the folded block, and counts again as the rows change", () => {
        const block = mountBlock(1400, 29);
        const visible = Math.floor((ClampedBodyBottom - Head) / RowHeight);
        expect(block.bar()).toEqual({ labelKey: "companion.block.showAllMore", count: 29 - visible, chevron: "down" });
        block.setContent(1600, 33);
        expect(block.bar().count).toBe(33 - visible);
    });

    it("says 'Show all' alone when the cap hides no row it can count, as the latest answer does", () => {
        const block = mountBlock(900, 0);
        expect(block.bar()).toEqual({ labelKey: "companion.block.showAll", chevron: "down" });
    });
});

describe("measuring a block in the page (#2477)", () => {
    it("reads the height the block would have without its clamp, whether or not it is clamped", () => {
        const section = new FakeSection();
        const body = new FakeBody();
        section.natural = 1400;
        const measure = (rows?: string) =>
            measureBlock(section as unknown as HTMLElement, body as unknown as HTMLElement, rows);
        expect(measure()).toEqual({ tall: true, hidden: 0 });
        section.setAttribute(BlockCappedAttr);
        expect(section.offsetHeight).toBe(BlockCapPx);
        expect(measure()).toEqual({ tall: true, hidden: 0 });
        section.natural = 300;
        expect(measure()).toEqual({ tall: false, hidden: 0 });
    });

    it("leaves the block as it found it: the probe is lifted before anything is painted", () => {
        const section = new FakeSection();
        const body = new FakeBody();
        body.rows = 5;
        section.natural = 900;
        section.setAttribute(BlockCappedAttr);
        measureBlock(section as unknown as HTMLElement, body as unknown as HTMLElement, RowsSelector);
        expect([...section.attrs]).toEqual([BlockCappedAttr]);
        section.removeAttribute(BlockCappedAttr);
        measureBlock(section as unknown as HTMLElement, body as unknown as HTMLElement, RowsSelector);
        expect(section.attrs.size).toBe(0);
    });

    it("counts rows only in a block that is folded and has rows to count", () => {
        const section = new FakeSection();
        const body = new FakeBody();
        body.rows = 29;
        section.natural = 1400;
        const measure = (rows?: string) =>
            measureBlock(section as unknown as HTMLElement, body as unknown as HTMLElement, rows);
        // Not folded yet (or unfolded): nothing is hidden.
        expect(measure(RowsSelector).hidden).toBe(0);
        section.setAttribute(BlockCappedAttr);
        expect(measure(RowsSelector).hidden).toBeGreaterThan(0);
        expect(measure(undefined).hidden).toBe(0);
        expect(measure("").hidden).toBe(0);
    });
});

describe("what makes a block measure itself again (#2477)", () => {
    it("follows the block's width and the elements of its body, and the rows that come and go", () => {
        const section = new FakeSection();
        const body = new FakeBody();
        const fake = fakeEnv();
        let measured = 0;
        const list = { id: "list" };
        body.children = [list];
        const watch = watchBlockCap(
            section as unknown as HTMLElement,
            body as unknown as HTMLElement,
            () => measured++,
            fake.env
        );
        const [ro] = fake.resize;
        const [mo] = fake.mutation;
        expect(ro.watched.has(section)).toBe(true);
        expect(ro.watched.has(list)).toBe(true);
        // The body is clipped once folded: the content's elements are what grow, not the body.
        ro.callback();
        expect(measured).toBe(1);
        // Never an attribute: measuring lifts and sets one, which must not start another measure.
        expect(mo.target).toBe(body);
        expect(mo.options).toEqual({ childList: true, subtree: true, characterData: true });
        const loading = { id: "loading" };
        body.children = [list, loading];
        mo.callback();
        expect(measured).toBe(2);
        expect(ro.watched.has(loading)).toBe(true);
        body.children = [loading];
        mo.callback();
        expect(ro.watched.has(list)).toBe(false);
        watch.stop();
        expect(ro.watched.size).toBe(0);
        expect(mo.target).toBeNull();
    });

    it("does nothing without a block or without the observers (a window-less test)", () => {
        expect(() => watchBlockCap(null, null, () => {}).stop()).not.toThrow();
        const section = new FakeSection() as unknown as HTMLElement;
        const body = new FakeBody() as unknown as HTMLElement;
        expect(() => watchBlockCap(section, body, () => {}, null).stop()).not.toThrow();
    });

    it("says only what changed: a block measured again with the same answer tells nobody", () => {
        const block = mountBlock(900, 10);
        const draws = block.page.draws;
        block.fake.resize[0].callback();
        block.fake.mutation[0].callback();
        block.follow.measure();
        expect(block.page.draws).toBe(draws);
    });
});

// The flow places the blocks by their measured height (FlowBlock.height): a block that unfolds or folds is a block that
// changes height, and what is under it moves. The page's observers hand the flow the new height on the same frame
// (companion-flow-watch.ts); here the flow's layout is run on those heights, as the dashboard runs it.
describe("the flow places the blocks again as one unfolds or folds (#2477)", () => {
    const natural: Record<string, number> = {
        permission: 90,
        tasks: 343,
        agents: 78,
        usage: 389,
        topics: 161,
        answer: 101,
        task: 214,
        files: 1400,
    };
    const full = new Set(["permission"]);
    const draw = (unfolded: string[], height: Record<string, number> = natural, skip: string[] = []): FlowBlock[] =>
        Object.keys(height)
            .filter((id) => !skip.includes(id))
            .map((id) => ({
                id,
                height: blockHeight(height[id], unfolded.includes(id)),
                full: full.has(id),
            }));
    const overlaps = (r: FlowResult, blocks: FlowBlock[]) => {
        const height = new Map(blocks.map((b) => [b.id, b.height]));
        const list = r.items.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.width, h: height.get(p.id) }));
        const hits: string[] = [];
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                    hits.push(`${a.id}/${b.id}`);
                }
            }
        }
        return hits;
    };
    const place = (blocks: FlowBlock[], width: number, previous?: FlowResult) =>
        flowLayout(blocks, width, previous?.assign);
    const at = (r: FlowResult, id: string) => r.items.find((p) => p.id === id);

    it("stops every block of the flow at the cap while they are folded, a long one or not", () => {
        const folded = draw([]);
        expect(folded.every((b) => b.height <= BlockCapPx)).toBe(true);
        expect(folded.find((b) => b.id === "files").height).toBe(BlockCapPx);
        expect(folded.find((b) => b.id === "agents").height).toBe(78);
    });

    for (const width of [468, 684, 968, 1200]) {
        it(`draws no two blocks over each other at ${width} px, folded, unfolded and folded again`, () => {
            let previous: FlowResult = null;
            for (const unfolded of [[], ["files"], ["files", "usage"], ["tasks"], [], ["answer"], []]) {
                const blocks = draw(unfolded);
                const r = place(blocks, width, previous);
                expect(overlaps(r, blocks), `${width} ${unfolded.join()}`).toEqual([]);
                previous = r;
            }
        });
    }

    it("moves what is under an unfolded block by what it grew, and brings it back once it is folded", () => {
        // One column: every block is under the one before it.
        const folded = place(draw([]), 468);
        const open = place(draw(["files"]), 468, folded);
        expect(at(open, "files").y).toBe(at(folded, "files").y);
        expect(open.height - folded.height).toBe(natural.files - BlockCapPx);
        // The blocks above the unfolded one stay where they were.
        for (const id of ["permission", "tasks", "agents", "usage", "topics", "answer", "task"]) {
            expect(at(open, id).y, id).toBe(at(folded, id).y);
        }
        const again = place(draw([]), 468, open);
        expect(again.items.map((p) => [p.id, p.x, p.y])).toEqual(folded.items.map((p) => [p.id, p.x, p.y]));
        expect(again.height).toBe(folded.height);
    });

    it("moves a block that fits in the cap by nothing when it is unfolded: the cap is a maximum, not a size", () => {
        const folded = place(draw([]), 684);
        const open = place(draw(["usage", "topics", "answer"]), 684, folded);
        expect(open.items.map((p) => [p.id, p.x, p.y])).toEqual(folded.items.map((p) => [p.id, p.x, p.y]));
        expect(open.height).toBe(folded.height);
    });

    it("moves the blocks under an unfolded one in its column, and the blocks of no other column", () => {
        const long = { ...natural, topics: 1300 };
        const folded = place(draw([], long), 684);
        const open = place(draw(["topics"], long), 684, folded);
        const topics = at(folded, "topics");
        const grew = 1300 - BlockCapPx;
        let moved = 0;
        for (const p of open.items) {
            const was = at(folded, p.id);
            expect(p.x, p.id).toBe(was.x);
            // Under the block, in its column, or across the columns (a full-width block waits for the tallest one).
            if (p.id !== "topics" && p.y > topics.y && (p.column === topics.column || p.full)) {
                expect(p.y, p.id).toBeGreaterThanOrEqual(was.y);
                moved += p.y > was.y ? 1 : 0;
            } else {
                expect(p.y, p.id).toBe(was.y);
            }
        }
        expect(moved).toBeGreaterThan(0);
        // The first block under it moved by what it grew.
        const under = folded.items
            .filter((p) => p.column === topics.column && p.y > topics.y)
            .sort((a, b) => a.y - b.y)[0];
        expect(at(open, under.id).y - under.y).toBe(grew);
        const again = place(draw([], long), 684, open);
        expect(again.items.map((p) => [p.id, p.x, p.y])).toEqual(folded.items.map((p) => [p.id, p.x, p.y]));
    });

    it("places a block that gained or lost its bar as the block of its new height", () => {
        // The content grows past the cap, then shrinks back: the block is 300, 500 (capped), 300.
        let previous: FlowResult = null;
        const heights: number[] = [];
        for (const content of [300, 900, 300]) {
            const block = mountBlock(content, 6);
            const blocks = draw([], { ...natural, topics: block.height() });
            previous = place(blocks, 684, previous);
            heights.push(blocks.find((b) => b.id === "topics").height);
            expect(overlaps(previous, blocks)).toEqual([]);
        }
        expect(heights).toEqual([300, BlockCapPx, 300]);
    });
});

describe("what the dashboard gives its blocks (#2477)", () => {
    it("tells a block whether the layout unfolded it", () => {
        const layout = setSectionUnfolded(DefaultCompanionLayout, "files", true);
        const value = makeBlockCapValue(layout, () => {});
        expect(CompanionSectionIds.filter((id) => value.unfolded(id))).toEqual(["files"]);
        expect(makeBlockCapValue(DefaultCompanionLayout, () => {}).unfolded("files")).toBe(false);
    });

    it("hands the layout with the block unfolded or folded to where the choice is kept", () => {
        const saved: unknown[] = [];
        const value = makeBlockCapValue(DefaultCompanionLayout, (next) => saved.push(next));
        value.toggle("files");
        expect(saved).toHaveLength(1);
        expect(isUnfolded(saved[0] as typeof DefaultCompanionLayout, "files")).toBe(true);
        expect(isUnfolded(saved[0] as typeof DefaultCompanionLayout, "topics")).toBe(false);
        // The next toggle reads the layout it was given: folding it takes the choice out again.
        const open = makeBlockCapValue(saved[0] as typeof DefaultCompanionLayout, (next) => saved.push(next));
        open.toggle("files");
        expect(isUnfolded(saved[1] as typeof DefaultCompanionLayout, "files")).toBe(false);
        expect(saved[1]).toEqual(DefaultCompanionLayout);
    });
});

// A browser lays the stylesheet out; here it is read, so that a rule that makes 500 px a size, or stretches a short block,
// or animates a height shows as a different number.
const Css = readFileSync(join(__dirname, "companion-dashboard.css"), "utf8");
const Rules = new Map<string, Map<string, string>>();
postcss.parse(Css).walkRules((rule) => {
    const key = rule.selector.replace(/\s+/g, " ").trim();
    const decls = Rules.get(key) ?? new Map<string, string>();
    rule.each((node) => {
        if (node.type === "decl") {
            decls.set(node.prop, node.value);
        }
    });
    Rules.set(key, decls);
});
const Transitions: { selector: string; value: string }[] = [];
postcss.parse(Css).walkDecls(/^(transition|animation)/, (decl) => {
    Transitions.push({ selector: (decl.parent as postcss.Rule).selector, value: decl.value });
});
const rule = (selector: string) => {
    const found = Rules.get(selector);
    if (found == null) {
        throw new Error(`no rule "${selector}"`);
    }
    return found;
};

describe("the cap in the stylesheet (#2477)", () => {
    it("is the numbers the code knows", () => {
        const dash = rule(".mt-cdash");
        expect(dash.get("--mt-cb-cap")).toBe(`${BlockCapPx}px`);
        expect(dash.get("--mt-cb-fade")).toBe(`${BlockFadePx}px`);
        expect(dash.get("--mt-cb-bar")).toBe(`${BlockBarPx}px`);
    });

    it("is a maximum: only a block measured tall and folded is clamped, and no block has a height of its own", () => {
        expect(rule(".mt-cb[data-capped]").get("max-height")).toBe("var(--mt-cb-cap)");
        for (const [selector, decls] of Rules) {
            if (/^\.mt-cb(\[[^\]]*\])*$/.test(selector) || /^\.mt-cdash-flow > \.mt-cb(\[[^\]]*\])*$/.test(selector)) {
                for (const prop of ["height", "min-height", "block-size", "min-block-size"]) {
                    expect(decls.has(prop), `${selector} ${prop}`).toBe(false);
                }
            }
            if (decls.has("max-height") && /\.mt-cb\b/.test(selector) && !/\.mt-cb-/.test(selector)) {
                expect(selector, "a clamp").toMatch(/\[data-capped\]/);
            }
        }
        expect(rule(".mt-cb").has("max-height")).toBe(false);
        expect(rule(".mt-cb[data-capped]").has("min-height")).toBe(false);
        expect(rule(".mt-cb[data-capped]").has("height")).toBe(false);
    });

    it("lifts the clamp and hides the bar while a block is measured", () => {
        expect(rule(".mt-cb[data-capped][data-probe]").get("max-height")).toBe("none");
        expect(rule(".mt-cb[data-probe] > .mt-cb-cap").get("display")).toBe("none");
    });

    it("clips and fades the body of a folded block only, over the last 90 px, and lets the flush rows reach its edges", () => {
        const body = rule(".mt-cb[data-capped] > .mt-cb-body");
        expect(body.get("overflow")).toBe("hidden");
        expect(body.get("min-height")).toBe("0");
        expect(body.get("mask-image")).toContain("var(--mt-cb-fade)");
        expect(body.get("margin-inline")).toBe("calc(var(--mt-companion-inset) * -1)");
        expect(body.get("padding-inline")).toBe("var(--mt-companion-inset)");
        // A block that is short, or unfolded, is not clipped and not faded.
        expect(rule(".mt-cb-body").has("overflow")).toBe(false);
        expect(rule(".mt-cb-body").has("mask-image")).toBe(false);
    });

    it("makes the bar a full-width button of 34 px on the block's bottom edge", () => {
        const bar = rule(".mt-cb-cap");
        expect(bar.get("height")).toBe("var(--mt-cb-bar)");
        expect(bar.get("margin")).toBe("0 calc(var(--mt-companion-inset) * -1) calc(var(--mt-companion-inset) * -1)");
        expect(bar.get("cursor")).toBe("pointer");
        expect(rule(".mt-cb-cap:focus-visible").get("outline")).toContain("var(--mt-focus)");
    });

    it("animates no height, and gives the bar's colour a token duration, which is nothing under reduced motion", () => {
        expect(Transitions.filter((t) => /height/.test(t.value))).toEqual([]);
        const bar = Transitions.filter((t) => t.selector === ".mt-cb-cap");
        expect(bar).toHaveLength(1);
        expect(bar[0].value).toContain("background-color var(--mt-duration-fast)");
    });
});
