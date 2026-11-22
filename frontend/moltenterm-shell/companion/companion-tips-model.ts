// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's popovers (FR-SHELL-018, #2455), pure: which element asks for one, what it says, how long it waits.
// An element names its hover text with data-tip instead of a native title (a test lists the companion's sources for
// any title left); a pasted image's chip names its number with data-image, and the answer's markdown, whose links are
// the only elements it can place, gets #mt-image-N links from imageLinks, which its renderer draws as the same chip.
//
// A popover opens only when it adds something to what the element shows: its text is cut on screen, or it says more
// than the element does (a full path, an exact date, the name of an action on an icon). tipAdds decides.

// The text of an element's popover. A line break starts a new line in it.
export const TipAttr = "data-tip";
// A pasted image's chip: its number in the session, and the time (Unix ms) of the message that holds it. The time
// is read from the element or its nearest ancestor that has one (the answer block names its answer's time).
export const ImageAttr = "data-image";
export const ImageAtAttr = "data-image-at";

// What a drag of a block dispatches on the document when it starts (#2459): an open popover closes, as it does on a press,
// since the pointer that carries the block was never pressed on the element the popover describes.
export const CloseTipsEvent = "mt-companion-tips-close";

// Opens after a pause when the pointer rests on an element, sooner when the keyboard focuses it.
export const HoverDelayMs = 350;
export const FocusDelayMs = 120;
// The popover of an image is about this large, in CSS pixels.
export const ImageMaxWidth = 320;
export const ImageMaxHeight = 240;
// The images the window keeps, by their size in bytes, so that a chip hovered again does not read the transcript again.
export const ImageCacheBytes = 16 * 1024 * 1024;

const AnswerImageHref = /^#mt-image-(\d{1,7})$/;
const ImagePlaceholder = /\[Image #(\d{1,7})\]/g;
const InlineCodeOrImage = /(`+)(?:(?!\1)[\s\S])*?\1|\[Image #(\d{1,7})\]/g;

export type TipTarget =
    | { kind: "text"; element: HTMLElement; text: string }
    | { kind: "image"; element: HTMLElement; n: number; at: number };

function elementOf(node: EventTarget): Element {
    if (node == null) {
        return null;
    }
    if (typeof (node as Element).closest === "function") {
        return node as Element;
    }
    return (node as Node).parentElement ?? null;
}

// The number an answer's link to #mt-image-N names, 0 for any other address.
export function pastedImageNumber(href: string): number {
    const m = AnswerImageHref.exec(href ?? "");
    return m == null ? 0 : Number(m[1]);
}

export function imageTime(element: Element): number {
    const holder = element.closest(`[${ImageAtAttr}]`);
    const at = Number(holder?.getAttribute(ImageAtAttr));
    return at > 0 ? at : 0;
}

// The text an element shows, without what only a screen reader gets.
function visibleTextOf(element: Element): string {
    if (typeof element.querySelector !== "function" || element.querySelector(".sr-only") == null) {
        return element.textContent ?? "";
    }
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll(".sr-only").forEach((hidden) => hidden.remove());
    return copy.textContent ?? "";
}

// Whitespace and the brackets of a placeholder do not tell a text from what the element shows ("[Image #2]" shows as
// the chip "Image #2").
function plain(text: string): string {
    return text.replace(/[\s[\]]+/g, "");
}

// tipRepeats: every line of the popover's text is already in the text the element shows.
export function tipRepeats(shown: string, tip: string): boolean {
    const visible = plain(shown ?? "");
    const lines = (tip ?? "")
        .split("\n")
        .map(plain)
        .filter((line) => line !== "");
    return lines.length > 0 && lines.every((line) => visible.includes(line));
}

const MaxClipChecks = 200;

function clippedBox(element: Element): boolean {
    if (element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1) {
        return false;
    }
    if (typeof getComputedStyle !== "function") {
        return true;
    }
    const style = getComputedStyle(element);
    return style.overflowX !== "visible" || style.overflowY !== "visible";
}

// isClipped: the element, or something inside it, shows less than its text: an ellipsis, a clamped line count.
export function isClipped(element: Element): boolean {
    if (clippedBox(element)) {
        return true;
    }
    const inside = typeof element.querySelectorAll === "function" ? Array.from(element.querySelectorAll("*")) : [];
    return inside.slice(0, MaxClipChecks).some(clippedBox);
}

// tipAdds: the popover is worth opening. It repeats nothing the element already shows in full.
export function tipAdds(element: Element, text: string): boolean {
    return !tipRepeats(visibleTextOf(element), text) || isClipped(element);
}

// tipTargetOf is what the nearest element at or above a node asks to show, null when none asks. A popover that adds
// nothing to its element is passed over: the next element above that has one that adds is asked instead.
export function tipTargetOf(node: EventTarget, within: Element = null, adds = tipAdds): TipTarget {
    let element = elementOf(node)?.closest(`[${TipAttr}], [${ImageAttr}]`) as HTMLElement;
    while (element != null && (within == null || within.contains(element))) {
        const n = Number(element.getAttribute(ImageAttr));
        if (n > 0) {
            return { kind: "image", element, n, at: imageTime(element) };
        }
        const text = element.getAttribute(TipAttr);
        if (text && adds(element, text)) {
            return { kind: "text", element, text };
        }
        element = element.parentElement?.closest(`[${TipAttr}], [${ImageAttr}]`) as HTMLElement;
    }
    return null;
}

export type TipRect = {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
};

// The box a popover about an element stands on (#2458). An element with `display: contents` (a row of the usage grid,
// whose cells are the grid's own) has no box: its rectangle is empty and sits at the page's corner, where the popover
// about the row stood. It stands on the union of the boxes of what the element holds instead. null: nothing to stand on.
export function contentsRect(
    element: Element,
    displayOf: (e: Element) => string = (e) => getComputedStyle(e).display
): TipRect {
    const boxes: DOMRect[] = [];
    const collect = (parent: Element) => {
        for (const child of Array.from(parent.children)) {
            if (displayOf(child) === "contents") {
                collect(child);
                continue;
            }
            const r = child.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) {
                boxes.push(r);
            }
        }
    };
    collect(element);
    if (boxes.length === 0) {
        return null;
    }
    const left = Math.min(...boxes.map((r) => r.left));
    const top = Math.min(...boxes.map((r) => r.top));
    const right = Math.max(...boxes.map((r) => r.right));
    const bottom = Math.max(...boxes.map((r) => r.bottom));
    return { x: left, y: top, width: right - left, height: bottom - top, top, right, bottom, left };
}

// The message text as parts: the text between the placeholders and the numbers the placeholders name.
export type MessagePart = { text: string } | { image: number };

export function messageParts(text: string): MessagePart[] {
    const rtn: MessagePart[] = [];
    let last = 0;
    for (const m of (text ?? "").matchAll(ImagePlaceholder)) {
        if (m.index > last) {
            rtn.push({ text: text.slice(last, m.index) });
        }
        rtn.push({ image: Number(m[1]) });
        last = m.index + m[0].length;
    }
    if (last < (text ?? "").length) {
        rtn.push({ text: text.slice(last) });
    }
    return rtn;
}

// imageLinks makes each "[Image #N]" of an answer's markdown a link to #mt-image-N, which the answer shows as a chip.
// Code, inline or fenced by the caller, is left as written.
export function imageLinks(line: string): string {
    return line.replace(InlineCodeOrImage, (match, _ticks, n) =>
        n == null ? match : `[\\[Image #${n}\\]](#mt-image-${n})`
    );
}

export function hasImagePlaceholder(text: string): boolean {
    return /\[Image #\d{1,7}\]/.test(text ?? "");
}

// The data URL of an image the window got from wavesrv.
export type CompanionImage = { mime: string; data: string };

export function imageSource(image: CompanionImage): string {
    return `data:${image.mime};base64,${image.data}`;
}

// The size of an image in bytes, from its base64.
export function imageBytes(image: CompanionImage): number {
    const data = image.data ?? "";
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

// A small cache of the images read, by key, bounded by ImageCacheBytes: the oldest go first. A read that failed is not
// kept (null is what it gives): the transcript may hold the image at the next hover.
export class ImageCache {
    private entries = new Map<string, Promise<CompanionImage>>();
    private sizes = new Map<string, number>();
    private total = 0;

    get(key: string): Promise<CompanionImage> {
        return this.entries.get(key);
    }

    load(key: string, read: () => Promise<CompanionImage>): Promise<CompanionImage> {
        const cached = this.entries.get(key);
        if (cached != null) {
            return cached;
        }
        const promise = read().then(
            (image) => {
                this.note(key, image?.data.length ?? 0);
                return image;
            },
            () => {
                this.entries.delete(key);
                return null as CompanionImage;
            }
        );
        this.entries.set(key, promise);
        return promise;
    }

    private note(key: string, size: number) {
        this.sizes.set(key, size);
        this.total += size;
        for (const oldest of this.entries.keys()) {
            if (this.total <= ImageCacheBytes || oldest === key) {
                break;
            }
            this.total -= this.sizes.get(oldest) ?? 0;
            this.sizes.delete(oldest);
            this.entries.delete(oldest);
        }
    }

    clear() {
        this.entries.clear();
        this.sizes.clear();
        this.total = 0;
    }
}
