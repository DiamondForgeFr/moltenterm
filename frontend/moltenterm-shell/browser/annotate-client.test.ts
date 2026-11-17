// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The capture of the page and the clipboard (FR-BRW-017 AC12, #2327).

import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClipboardLike, copyTextLater, takeCapture } from "./annotate-client";

const Png = "data:image/png;base64," + "A".repeat(300);

describe("the picture of the page", () => {
    it("is the page's own, which holds nothing the window draws over it, and the window's is not even asked", async () => {
        const window = vi.fn(async () => Png);
        const taken = await takeCapture(async () => Png, window);
        expect(taken).toEqual({ url: Png, own: true });
        expect(window).not.toHaveBeenCalled();
    });

    it("is the window's picture of the panel when the page gives none, empty or failing", async () => {
        const other = "data:image/png;base64," + "B".repeat(300);
        expect(
            await takeCapture(
                async () => "",
                async () => other
            )
        ).toEqual({ url: other, own: false });
        expect(
            await takeCapture(
                async () => "data:image/png;base64,AA",
                async () => other
            )
        ).toEqual({
            url: other,
            own: false,
        });
        expect(
            await takeCapture(
                async () => {
                    throw new Error("not loaded");
                },
                async () => other
            )
        ).toEqual({ url: other, own: false });
        expect(await takeCapture(null, async () => other)).toEqual({ url: other, own: false });
    });

    it("is nothing when neither can be taken", async () => {
        expect(
            await takeCapture(
                async () => "",
                async () => {
                    throw new Error("hidden window");
                }
            )
        ).toEqual({ url: "", own: false });
    });
});

type Item = { type: string; blob: Promise<Blob> };

describe("copying the report", () => {
    afterEach(() => vi.unstubAllGlobals());

    function clipboard(write?: ClipboardLike["write"]) {
        const writeText = vi.fn(async () => {});
        return { writeText, write } satisfies ClipboardLike;
    }

    const item = (type: string, blob: Promise<Blob>): Item => ({ type, blob });

    it("starts the write inside the click, with a promise for the text, and finishes when the report is there", async () => {
        vi.stubGlobal("ClipboardItem", class {});
        const written: Item[][] = [];
        const board = clipboard(async (items) => {
            written.push(items as Item[]);
            await (items[0] as Item).blob;
        });
        let resolveText: (text: string) => void;
        const text = new Promise<string>((resolve) => (resolveText = resolve));
        const done = copyTextLater(text, board, item);
        expect(written).toHaveLength(1);
        expect(written[0][0].type).toBe("text/plain");
        resolveText("The report's text.");
        await done;
        expect(await (await written[0][0].blob).text()).toBe("The report's text.");
        expect(board.writeText).not.toHaveBeenCalled();
    });

    it("waits for the text and writes it when the browser refuses a write with a promise", async () => {
        vi.stubGlobal("ClipboardItem", class {});
        const board = clipboard(async () => {
            throw new Error("refused");
        });
        await copyTextLater(Promise.resolve("The report's text."), board, item);
        expect(board.writeText).toHaveBeenCalledWith("The report's text.");
    });

    it("waits for the text and writes it when the browser cannot write items at all", async () => {
        const board = clipboard();
        await copyTextLater(Promise.resolve("The report's text."), board, item);
        expect(board.writeText).toHaveBeenCalledWith("The report's text.");
    });

    it("fails with the report's failure, and writes nothing", async () => {
        vi.stubGlobal("ClipboardItem", class {});
        const board = clipboard(async (items) => {
            await (items[0] as Item).blob;
        });
        await expect(copyTextLater(Promise.reject(new Error("no report")), board, item)).rejects.toThrow("no report");
        expect(board.writeText).not.toHaveBeenCalled();
    });
});
