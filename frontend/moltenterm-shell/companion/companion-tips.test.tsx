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
    hasImagePlaceholder,
    ImageAtAttr,
    ImageAttr,
    imageBytes,
    ImageCache,
    ImageCacheBytes,
    imageLinks,
    imageNumber,
    imageSource,
    messageParts,
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

// Just enough of an element for the lookup: attributes, a parent and the three selectors it asks for.
class FakeElement {
    constructor(
        public tag: string,
        public attrs: Record<string, string>,
        public parent: FakeElement = null,
        public kids: FakeElement[] = []
    ) {
        parent?.kids.push(this);
    }
    get parentElement() {
        return this.parent;
    }
    getAttribute(name: string): string {
        return this.attrs[name] ?? null;
    }
    contains(other: FakeElement): boolean {
        for (let el = other; el != null; el = el.parent) {
            if (el === this) {
                return true;
            }
        }
        return false;
    }
    private matches(selector: string): boolean {
        for (const part of selector.split(",").map((s) => s.trim())) {
            const anchor = /^a\[href\^="([^"]*)"\]$/.exec(part);
            if (anchor != null) {
                if (this.tag === "a" && (this.attrs["href"] ?? "").startsWith(anchor[1])) {
                    return true;
                }
                continue;
            }
            const attr = /^\[([\w-]+)\]$/.exec(part);
            if (attr != null && this.attrs[attr[1]] != null) {
                return true;
            }
        }
        return false;
    }
    closest(selector: string): FakeElement {
        return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
    }
}

describe("which element asks for a popover (#2455)", () => {
    const panel = new FakeElement("div", {});
    const row = new FakeElement("li", { "data-tip": "Branch: feature/1" }, panel);
    const word = new FakeElement("span", {}, row);
    const chip = new FakeElement("button", { [ImageAttr]: "4", [ImageAtAttr]: "1700" }, row);
    const answer = new FakeElement("div", { [ImageAtAttr]: "555" }, panel);
    const link = new FakeElement("a", { href: "#mt-image-12" }, answer);
    const plain = new FakeElement("a", { href: "#heading" }, answer);
    const outside = new FakeElement("span", { "data-tip": "elsewhere" });

    it("reads the nearest element above the pointer", () => {
        expect(tipTargetOf(word as any, panel as any)).toEqual({
            kind: "text",
            element: row,
            text: "Branch: feature/1",
        });
        expect(tipTargetOf(row as any, panel as any)?.kind).toBe("text");
    });

    it("prefers a chip inside a row to the row's own text, and reads its message's time", () => {
        expect(tipTargetOf(chip as any, panel as any)).toEqual({ kind: "image", element: chip, n: 4, at: 1700 });
    });

    it("reads an answer's link as a chip, its time from the answer block", () => {
        expect(tipTargetOf(link as any, panel as any)).toEqual({ kind: "image", element: link, n: 12, at: 555 });
        expect(imageNumber(link as any)).toBe(12);
        expect(tipTargetOf(plain as any, panel as any)).toBeNull();
    });

    it("asks for nothing outside the panel, over text without a popover or without a target", () => {
        expect(tipTargetOf(outside as any, panel as any)).toBeNull();
        expect(tipTargetOf(panel as any, panel as any)).toBeNull();
        expect(tipTargetOf(null, panel as any)).toBeNull();
        const empty = new FakeElement("span", { "data-tip": "" }, panel);
        expect(tipTargetOf(empty as any, panel as any)).toBeNull();
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
