// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's popovers (FR-SHELL-018, #2455), pure: which element asks for one, what it says, how long it waits.
// An element names its hover text with data-tip instead of a native title (a test lists the companion's sources for
// any title left); a pasted image's chip names its number with data-image, and the answer's markdown, whose links are
// the only elements it can place, gets #mt-image-N links from imageLinks.

// The text of an element's popover. A line break starts a new line in it.
export const TipAttr = "data-tip";
// A pasted image's chip: its number in the session, and the time (Unix ms) of the message that holds it. The time
// is read from the element or its nearest ancestor that has one (the answer block names its answer's time).
export const ImageAttr = "data-image";
export const ImageAtAttr = "data-image-at";

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

// imageNumber is the number a chip names: its data-image, or the one its answer link's address holds.
export function imageNumber(element: Element): number {
    const attr = Number(element.getAttribute(ImageAttr));
    if (attr > 0) {
        return attr;
    }
    const m = AnswerImageHref.exec(element.getAttribute("href") ?? "");
    return m == null ? 0 : Number(m[1]);
}

export function imageTime(element: Element): number {
    const holder = element.closest(`[${ImageAtAttr}]`);
    const at = Number(holder?.getAttribute(ImageAtAttr));
    return at > 0 ? at : 0;
}

// tipTargetOf is what the nearest element at or above a node asks to show, null when none asks.
export function tipTargetOf(node: EventTarget, within: Element = null): TipTarget {
    const start = elementOf(node);
    const element = start?.closest(`[${TipAttr}], [${ImageAttr}], a[href^="#mt-image-"]`) as HTMLElement;
    if (element == null || (within != null && !within.contains(element))) {
        return null;
    }
    const n = imageNumber(element);
    if (n > 0) {
        return { kind: "image", element, n, at: imageTime(element) };
    }
    const text = element.getAttribute(TipAttr);
    return text ? { kind: "text", element, text } : null;
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
