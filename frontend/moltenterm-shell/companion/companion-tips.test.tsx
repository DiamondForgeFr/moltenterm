// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { setSectionHidden } from "./companion-arrange-model";
import { CompanionDashboard, CompanionDashboardProps } from "./companion-dashboard";
import { ImageAccessContext } from "./companion-image-access";
import { ImageChip, MessageText } from "./companion-image-chip";
import { CompanionLayout, DefaultCompanionLayout } from "./companion-layout";
import { companionMarkdown, CompanionView } from "./companion-model";
import { topicRows } from "./companion-recap-model";
import { ImageTip, ImageTipView } from "./companion-tips";
import {
    contentsRect,
    hasImagePlaceholder,
    ImageAtAttr,
    ImageAttr,
    imageBytes,
    ImageCache,
    ImageCacheBytes,
    imageLinks,
    imageSource,
    messageParts,
    tipAdds,
    tipRepeats,
    tipTargetOf,
} from "./companion-tips-model";

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const off = atom(false);
    return {
        openLink: vi.fn(),
        getSettingsKeyAtom: () => off,
        getApi: () => ({}),
        createBlockSplitHorizontally: vi.fn(),
    };
});
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: { getInstance: () => ({ showContextMenu: vi.fn() }) },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(), SetConfigCommand: vi.fn() } }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: null }) } }));
vi.mock("@/app/element/markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: () => null }));
vi.mock("@/app/store/tab-model", () => ({ getActiveTabModel: () => null }));

// ── The companion's own sources, scanned while the file is collected (collection has no timeout) ──────────────────────

const CompanionDir = resolve(__dirname);

type Found = { file: string; line: number; tag: string };

function scanSources(): { titles: Found[]; tips: number; elements: number } {
    const titles: Found[] = [];
    let tips = 0;
    let elements = 0;
    for (const name of readdirSync(CompanionDir)) {
        if (!/\.tsx$/.test(name) || /\.test\.tsx$/.test(name)) {
            continue;
        }
        const source = ts.createSourceFile(
            name,
            readFileSync(join(CompanionDir, name), "utf8"),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX
        );
        const visit = (node: ts.Node) => {
            if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
                const tag = node.tagName.getText(source);
                // A component's title is its own prop (a dialog's, an empty state's); only a DOM element's is native.
                if (/^[a-z]/.test(tag)) {
                    elements++;
                    for (const attr of node.attributes.properties) {
                        if (!ts.isJsxAttribute(attr)) {
                            continue;
                        }
                        const attrName = attr.name.getText(source);
                        if (attrName === "title") {
                            const line = source.getLineAndCharacterOfPosition(attr.getStart(source)).line + 1;
                            titles.push({ file: name, line, tag });
                        }
                        if (attrName === "data-tip") {
                            tips++;
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return { titles, tips, elements };
}

const Scan = scanSources();

describe("the companion has no native tooltip (FR-SHELL-018, #2455)", () => {
    it("lists no DOM element of the companion that still sets title", () => {
        expect(Scan.titles.map((f) => `${f.file}:${f.line} <${f.tag} title>`)).toEqual([]);
    });

    it("sees the elements that say their text in a popover", () => {
        // A scan that found nothing would pass the test above: it has to see the popovers' attributes.
        expect(Scan.elements).toBeGreaterThan(200);
        expect(Scan.tips).toBeGreaterThan(40);
    });
});

// ── The dashboard as it renders ───────────────────────────────────────────────────────────────────────────────────────

const noop = () => {};
const now = Date.now();

const agentState: AgentStateInfo = {
    blockid: "t1",
    agent: "claude",
    agentname: "Claude Code",
    firstname: "Flore",
    state: "working",
    version: 1,
};

const view: CompanionView = {
    blockid: "t1",
    version: 1,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    session: {
        path: "/s/a.jsonl",
        linkedby: "hook",
        title: "Fix the layout of [Image #3]",
        started: now - 60_000,
        branch: "feature/41-layout",
    },
    topics: [
        { text: "Compare [Image #4] with [Image #5] again", at: 1700000000000, last: now - 60_000, files: 2 },
        { text: "Write the tests", at: 1700000100000, last: now - 120_000 },
    ],
    answers: [{ index: 0, at: 1700000200000, preview: "See" }],
    latest: { index: 0, at: 1700000200000, latest: true, markdown: "As in [Image #7] and `[Image #8]`." },
    files: [{ path: "/w/src/a.ts", kind: "update", added: 1, removed: 0, edits: 1 }],
    todos: [
        { text: "Read the screenshot", status: "completed" },
        { text: "Fix the spacing", status: "in_progress" },
    ],
    subagents: [{ id: "s1", description: "#41 Fix the total", state: "running", started: now - 60_000 }],
};

function markup(layout: CompanionLayout, extra: Partial<CompanionDashboardProps> = {}): string {
    return renderToStaticMarkup(
        <CompanionDashboard
            view={view}
            target="t1"
            companionId="c1"
            agentState={agentState}
            provider=""
            dir=""
            folder="/w"
            layout={layout}
            onSaveLayout={noop}
            arranging={false}
            onArrange={noop}
            onLeaveArranging={noop}
            arrangeRef={{ current: null }}
            integrationDetails={false}
            persistentIntegration={false}
            onIntegration={noop}
            onHistory={noop}
            onBackToCurrent={noop}
            fixtures={{ milestones: { dir: "/w", state: "none" } }}
            {...extra}
        />
    );
}

describe("the dashboard says its hover texts in popovers (#2455)", () => {
    it("renders no title attribute, flowing or arranging, with a block hidden or not", () => {
        for (const html of [
            markup(DefaultCompanionLayout),
            markup(DefaultCompanionLayout, { arranging: true }),
            markup(setSectionHidden(DefaultCompanionLayout, "topics", true)),
        ]) {
            expect(html).not.toMatch(/ title="/);
            expect(html).toContain('data-tip="');
        }
    });

    it("gives the hero, the topics and the plan their texts", () => {
        const html = markup(DefaultCompanionLayout);
        expect(html).toContain('data-tip="/s/a.jsonl');
        expect(html).toContain('data-tip="Fix the spacing"');
        expect(html).toContain('data-testid="companion-topic"');
    });

    it("keeps the usage page, the history and the arrange tools named for assistive technology", () => {
        const html = markup(DefaultCompanionLayout);
        expect(html).toMatch(/aria-label="[^"]+"[^>]*data-tip="[^"]+"[^>]*data-testid="companion-history-open"/);
        expect(html).toMatch(/aria-label="[^"]+"[^>]*data-tip="[^"]+"[^>]*data-testid="companion-copy"/);
    });
});

// ── A pasted image's chip ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the chips of pasted images (#2455)", () => {
    it("cuts a message into its text and its placeholders", () => {
        expect(messageParts("Compare [Image #4] with [Image #5] again")).toEqual([
            { text: "Compare " },
            { image: 4 },
            { text: " with " },
            { image: 5 },
            { text: " again" },
        ]);
        expect(messageParts("[Image #28]")).toEqual([{ image: 28 }]);
        expect(messageParts("no image, [Image] and [Image #x] and [image #1]")).toEqual([
            { text: "no image, [Image] and [Image #x] and [image #1]" },
        ]);
        expect(messageParts("")).toEqual([]);
        expect(messageParts(undefined)).toEqual([]);
        expect(hasImagePlaceholder("see [Image #3]")).toBe(true);
        expect(hasImagePlaceholder("see Image 3")).toBe(false);
    });

    it("draws a chip in place of a placeholder, with its number and the time of its message", () => {
        const html = renderToStaticMarkup(<MessageText text="Compare [Image #4] later" at={1700000000000} />);
        expect(html).toContain("Compare ");
        expect(html).toContain(" later");
        expect(html).toMatch(/<button type="button" class="mt-cdash-imgchip"[^>]*data-image="4"/);
        expect(html).toContain('data-image-at="1700000000000"');
        expect(html).toContain("Image #4");
        expect(renderToStaticMarkup(<ImageChip n={9} />)).not.toContain("data-image-at");
        expect(renderToStaticMarkup(<MessageText text="plain" />)).toBe("plain");
    });

    it("shows the chips in the hero's subject, the recent topics and the answer", () => {
        const html = markup(DefaultCompanionLayout);
        const subject = html.slice(html.indexOf('data-testid="companion-session-title"'));
        expect(subject.slice(0, subject.indexOf("</p>"))).toContain('data-image="3"');
        const topics = html.slice(html.indexOf('data-testid="companion-topics"'));
        expect(topics).toContain('data-image="4"');
        expect(topics).toContain('data-image="5"');
        expect(topics).toContain('data-image-at="1700000000000"');
        // The answer is markdown: the placeholder is a link the answer draws as a chip, its time on its block; inside
        // code it stays as written.
        const answer = html.slice(html.indexOf('class="mt-cdash-answer"'));
        expect(answer).toContain('data-image-at="1700000200000"');
        expect(answer).toContain("[\\[Image #7\\]](#mt-image-7)");
        expect(answer).toContain("`[Image #8]`");
    });

    it("topic rows carry the time of their prompt", () => {
        expect(topicRows(view.topics, now).map((r) => r.at)).toEqual([1700000000000, 1700000100000]);
        expect(topicRows([{ text: "x" }], now)[0].at).toBe(0);
    });

    it("makes the answer's placeholders links, outside code only", () => {
        expect(imageLinks("As in [Image #7].")).toBe("As in [\\[Image #7\\]](#mt-image-7).");
        expect(imageLinks("`[Image #1]` and [Image #2]")).toBe("`[Image #1]` and [\\[Image #2\\]](#mt-image-2)");
        expect(imageLinks("``a ` [Image #1] ``")).toBe("``a ` [Image #1] ``");
        expect(imageLinks("none here")).toBe("none here");
        expect(companionMarkdown("[Image #2]\n```\n[Image #3]\n```\n[Image #4]")).toBe(
            "[\\[Image #2\\]](#mt-image-2)\n```\n[Image #3]\n```\n[\\[Image #4\\]](#mt-image-4)"
        );
    });
});

// ── Which element asks for a popover, and what it says ───────────────────────────────────────────────────────────────

// Just enough of an element for the lookup: attributes, a parent, its text, the room its text has and the attribute
// selectors it asks for.
class FakeNode {
    parent: FakeNode = null;
    kids: FakeNode[] = [];
    constructor(
        public attrs: Record<string, string> = {},
        public text = "",
        // What the box holds and what it shows: a text cut by an ellipsis or a line count holds more than it shows.
        public box = { scrollWidth: 100, clientWidth: 100, scrollHeight: 20, clientHeight: 20 },
        public srOnly = false
    ) {}
    add(kid: FakeNode): FakeNode {
        kid.parent = this;
        this.kids.push(kid);
        return kid;
    }
    get scrollWidth() {
        return this.box.scrollWidth;
    }
    get clientWidth() {
        return this.box.clientWidth;
    }
    get scrollHeight() {
        return this.box.scrollHeight;
    }
    get clientHeight() {
        return this.box.clientHeight;
    }
    get parentElement() {
        return this.parent;
    }
    get textContent(): string {
        return this.text + this.kids.map((k) => k.textContent).join("");
    }
    getAttribute(name: string): string {
        return this.attrs[name] ?? null;
    }
    contains(other: FakeNode): boolean {
        for (let el = other; el != null; el = el.parent) {
            if (el === this) {
                return true;
            }
        }
        return false;
    }
    private all(): FakeNode[] {
        return this.kids.flatMap((k) => [k, ...k.all()]);
    }
    querySelectorAll(selector: string): FakeNode[] {
        return selector === ".sr-only" ? this.all().filter((n) => n.srOnly) : this.all();
    }
    querySelector(selector: string): FakeNode {
        return this.querySelectorAll(selector)[0] ?? null;
    }
    cloneNode(): FakeNode {
        const copy = new FakeNode({ ...this.attrs }, this.text, { ...this.box }, this.srOnly);
        this.kids.forEach((k) => copy.add(k.cloneNode()));
        return copy;
    }
    remove() {
        this.parent.kids = this.parent.kids.filter((k) => k !== this);
    }
    private matches(selector: string): boolean {
        return selector.split(",").some((part) => {
            const attr = /^\[([\w-]+)\]$/.exec(part.trim());
            return attr != null && this.attrs[attr[1]] != null;
        });
    }
    closest(selector: string): FakeNode {
        return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
    }
}

const Cut = { scrollWidth: 240, clientWidth: 120, scrollHeight: 20, clientHeight: 20 };
const Clamped = { scrollWidth: 120, clientWidth: 120, scrollHeight: 51, clientHeight: 34 };

describe("which element asks for a popover (#2455)", () => {
    const always = () => true;
    const panel = new FakeNode();
    const row = panel.add(new FakeNode({ "data-tip": "Branch: feature/1" }, "Fix the total"));
    const word = row.add(new FakeNode());
    const chip = row.add(new FakeNode({ [ImageAttr]: "4", [ImageAtAttr]: "1700" }, "Image #4"));
    const outside = new FakeNode({ "data-tip": "elsewhere" });

    it("reads the nearest element above the pointer", () => {
        expect(tipTargetOf(word as any, panel as any, always)).toEqual({
            kind: "text",
            element: row,
            text: "Branch: feature/1",
        });
        expect(tipTargetOf(row as any, panel as any, always)?.kind).toBe("text");
    });

    it("prefers a chip inside a row to the row's own text, and reads its message's time", () => {
        expect(tipTargetOf(chip as any, panel as any, always)).toEqual({
            kind: "image",
            element: chip,
            n: 4,
            at: 1700,
        });
    });

    it("reads the time of a chip from the nearest block that names one", () => {
        const answer = panel.add(new FakeNode({ [ImageAtAttr]: "555" }));
        const inList = answer.add(new FakeNode({ [ImageAttr]: "12" }));
        expect(tipTargetOf(inList as any, panel as any, always)).toEqual({
            kind: "image",
            element: inList,
            n: 12,
            at: 555,
        });
    });

    it("asks for nothing outside the panel, over text without a popover or without a target", () => {
        expect(tipTargetOf(outside as any, panel as any, always)).toBeNull();
        expect(tipTargetOf(panel as any, panel as any, always)).toBeNull();
        expect(tipTargetOf(null, panel as any, always)).toBeNull();
        const empty = panel.add(new FakeNode({ "data-tip": "" }));
        expect(tipTargetOf(empty as any, panel as any, always)).toBeNull();
    });

    it("passes over a popover that adds nothing and asks the element above that has one", () => {
        const list = new FakeNode();
        const group = list.add(new FakeNode({ "data-tip": "The whole group, with its branch" }, "Group"));
        const title = group.add(new FakeNode({ "data-tip": "Search the settings" }, "Search the settings"));
        expect(tipTargetOf(title as any, list as any)).toEqual({
            kind: "text",
            element: group,
            text: "The whole group, with its branch",
        });
        const alone = new FakeNode();
        const lone = alone.add(new FakeNode({ "data-tip": "Search the settings" }, "Search the settings"));
        expect(tipTargetOf(lone as any, alone as any)).toBeNull();
    });
});

// A row of the usage grid is display: contents: its own rectangle is empty and at the page's corner (#2458).
describe("the box a popover stands on", () => {
    type Box = { left: number; top: number; right: number; bottom: number };
    class FakeBox {
        children: FakeBox[] = [];
        constructor(
            public display: string,
            private box: Box = null
        ) {}
        add(child: FakeBox): FakeBox {
            this.children.push(child);
            return child;
        }
        getBoundingClientRect() {
            const b = this.box ?? { left: 0, top: 0, right: 0, bottom: 0 };
            return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top };
        }
    }
    const displayOf = (e: unknown) => (e as FakeBox).display;

    it("is the union of the boxes of what a display: contents element holds, nested ones too", () => {
        const row = new FakeBox("contents");
        row.add(new FakeBox("block", { left: 40, top: 100, right: 140, bottom: 113 }));
        row.add(new FakeBox("block", { left: 144, top: 102, right: 300, bottom: 108 }));
        const group = row.add(new FakeBox("contents"));
        group.add(new FakeBox("flex", { left: 304, top: 98, right: 360, bottom: 116 }));
        row.add(new FakeBox("block", { left: 144, top: 118, right: 300, bottom: 130 }));
        expect(contentsRect(row as any, displayOf)).toEqual({
            x: 40,
            y: 98,
            width: 320,
            height: 32,
            top: 98,
            right: 360,
            bottom: 130,
            left: 40,
        });
    });

    it("leaves out what has no box and says there is none when nothing holds one", () => {
        const row = new FakeBox("contents");
        row.add(new FakeBox("block"));
        expect(contentsRect(row as any, displayOf)).toBeNull();
        row.add(new FakeBox("block", { left: 5, top: 6, right: 25, bottom: 16 }));
        expect(contentsRect(row as any, displayOf)).toMatchObject({ left: 5, top: 6, width: 20, height: 10 });
    });

    it("is used by the popover's surface for such an element only", () => {
        const source = readFileSync(join(__dirname, "companion-tips.tsx"), "utf8");
        expect(source).toContain('getComputedStyle(element).display !== "contents"');
        expect(source).toContain("refs.setPositionReference(placement)");
    });
});

describe("a popover opens only when it adds something (#2455)", () => {
    it("compares the lines of the popover with what the element shows", () => {
        expect(tipRepeats("Imported settings keep their order", "Imported settings keep their order")).toBe(true);
        expect(tipRepeats("#824Imported settings", "#824 Imported settings")).toBe(true);
        expect(tipRepeats("Redo it like Image #1: now", "Redo it like [Image #1]: now")).toBe(true);
        expect(tipRepeats("Imported settings", "Ticket title: Imported settings")).toBe(false);
        expect(tipRepeats("Week 63 %", "This week: 62.8 % used\nResets Fri 10:00")).toBe(false);
        expect(tipRepeats("Fix the total · 2 files", "Fix the total\nBranch: feature/41")).toBe(false);
        expect(tipRepeats("", "Refresh")).toBe(false);
        expect(tipRepeats("anything", "")).toBe(false);
    });

    it("gives no popover to a row title shown in full with nothing more to say", () => {
        const row = new FakeNode(
            { "data-tip": "Imported settings keep their order" },
            "Imported settings keep their order"
        );
        expect(tipAdds(row as any, "Imported settings keep their order")).toBe(false);
    });

    it("gives one to a title that is cut: by an ellipsis, by a clamped line count or inside the element", () => {
        const cutRow = new FakeNode({}, "Imported settings keep their order", Cut);
        expect(tipAdds(cutRow as any, "Imported settings keep their order")).toBe(true);
        const clamped = new FakeNode({}, "A long prompt that takes three lines", Clamped);
        expect(tipAdds(clamped as any, "A long prompt that takes three lines")).toBe(true);
        const li = new FakeNode();
        li.add(new FakeNode({}, "A long prompt", Clamped));
        li.add(new FakeNode({}, " · 2 files"));
        expect(tipAdds(li as any, "A long prompt")).toBe(true);
    });

    it("gives one that says more than the element shows", () => {
        const row = new FakeNode({}, "Imported settings keep their order");
        expect(tipAdds(row as any, "Ticket title: Imported settings keep their order")).toBe(true);
        const week = new FakeNode({}, "Week 63 %");
        expect(tipAdds(week as any, "This week: 62.8 % used\nResets Fri 10:00\nPer day: Mon 0 %")).toBe(true);
        const path = new FakeNode({}, "settings/search-index.ts");
        expect(tipAdds(path as any, "/work/lantern/src/settings/search-index.ts")).toBe(true);
    });

    it("gives one to an icon alone: the name of its action", () => {
        const tool = new FakeNode({}, "");
        expect(tipAdds(tool as any, "Copy the answer as markdown")).toBe(true);
    });

    it("does not count what only a screen reader gets as shown", () => {
        const note = new FakeNode({}, "Plan usage: Kimi");
        note.add(new FakeNode({}, ": Behind another provider, so not this agent's usage", undefined, true));
        expect(tipAdds(note as any, "Behind another provider, so not this agent's usage")).toBe(true);
    });
});

// ── The image a chip reads ────────────────────────────────────────────────────────────────────────────────────────────

describe("the image of a chip (#2455)", () => {
    const image = { mime: "image/png", data: "AAAA" };

    it("is a data URL, and its size comes from its base64", () => {
        expect(imageSource(image)).toBe("data:image/png;base64,AAAA");
        expect(imageBytes({ mime: "image/png", data: "AAAA" })).toBe(3);
        expect(imageBytes({ mime: "image/png", data: "AAA=" })).toBe(2);
        expect(imageBytes({ mime: "image/png", data: "AA==" })).toBe(1);
        expect(imageBytes({ mime: "image/png", data: "" })).toBe(0);
    });

    it("says what is read, what is found and that none is", () => {
        const loading = renderToStaticMarkup(<ImageTipView n={3} image={undefined} pixels={null} onPixels={noop} />);
        expect(loading).toContain('data-testid="companion-image-loading"');
        const missing = renderToStaticMarkup(<ImageTipView n={3} image={null} pixels={null} onPixels={noop} />);
        expect(missing).toContain("Image unavailable");
        const found = renderToStaticMarkup(<ImageTipView n={3} image={image} pixels={[640, 480]} onPixels={noop} />);
        expect(found).toContain('src="data:image/png;base64,AAAA"');
        expect(found).toContain('alt="Pasted image 3"');
        expect(found).toMatch(/640 × 480 px · 3\sB/);
        expect(found).toMatch(/max-width:\s*320px;\s*max-height:\s*240px/);
    });

    it("starts as the reading of its image, before the window knows anything of it", () => {
        const access = { load: vi.fn(async () => image) };
        const html = renderToStaticMarkup(
            <ImageAccessContext.Provider value={access}>
                <ImageTip n={3} at={0} />
            </ImageAccessContext.Provider>
        );
        expect(html).toContain('data-testid="companion-image-loading"');
        expect(renderToStaticMarkup(<ImageTip n={3} at={0} />)).toContain("companion-image-loading");
    });

    it("is read once per key, and a failure is read again", async () => {
        const cache = new ImageCache();
        const read = vi.fn(async () => image);
        expect(await cache.load("a", read)).toBe(image);
        expect(await cache.load("a", read)).toBe(image);
        expect(read).toHaveBeenCalledTimes(1);
        const failing = vi.fn(async () => {
            throw new Error("none");
        });
        expect(await cache.load("b", failing)).toBeNull();
        expect(await cache.load("b", failing)).toBeNull();
        expect(failing).toHaveBeenCalledTimes(2);
    });

    it("keeps no more than its budget, the oldest going first", async () => {
        const cache = new ImageCache();
        const big = (n: number) => ({ mime: "image/png", data: "A".repeat(Math.floor(ImageCacheBytes / 3)) + n });
        for (let i = 0; i < 5; i++) {
            await cache.load(`k${i}`, async () => big(i));
        }
        expect(cache.get("k0")).toBeUndefined();
        expect(cache.get("k4")).toBeDefined();
        cache.clear();
        expect(cache.get("k4")).toBeUndefined();
    });
});
