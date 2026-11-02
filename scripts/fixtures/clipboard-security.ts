// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { extractAllClipboardData, extractClipboardData, extractDataTransferItems } from "../../frontend/app/view/term/termutil";

function check(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

function clipboardItem(values: Record<string, string | Blob>): ClipboardItem {
    return {
        types: Object.keys(values),
        getType: async (type: string) => {
            const value = values[type];
            return typeof value === "string" ? new Blob([value], { type }) : value;
        },
    } as ClipboardItem;
}

function transfer(values: Record<string, string>, images: File[] = []): DataTransfer {
    const data = new DataTransfer();
    for (const [type, value] of Object.entries(values)) data.setData(type, value);
    for (const image of images) data.items.add(image);
    return data;
}

async function browserBarrier(): Promise<void> {
    // A cancelled request round trip drains queued resource requests without a timing assumption.
    await fetch("https://clipboard-check.invalid/barrier").catch(() => {});
    await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

const state = { executed: false };
Object.assign(globalThis, {
    clipboardPayloadExecuted: () => { state.executed = true; },
    async clipboardPositiveControl() {
        await new Promise<void>((resolve) => {
            Object.assign(globalThis, { clipboardControlExecuted: resolve });
            const div = document.createElement("div");
            div.innerHTML = '<img src="https://clipboard-check.invalid/control" onerror="clipboardControlExecuted()">';
        });
    },
    async runClipboardChecks() {
        state.executed = false;
        const payloads = [
            '<img src="https://clipboard-check.invalid/image" onerror="clipboardPayloadExecuted()">kept',
            '<img src="data:image/png,invalid" onerror="clipboardPayloadExecuted()">kept',
            '<svg onload="clipboardPayloadExecuted()"><image href="https://clipboard-check.invalid/svg" /></svg>kept',
            '<iframe src="https://clipboard-check.invalid/frame" onload="clipboardPayloadExecuted()"></iframe>kept',
            '<link rel="stylesheet" href="https://clipboard-check.invalid/style">kept',
            '<object data="https://clipboard-check.invalid/object"></object>kept',
            '<script src="https://clipboard-check.invalid/script"></script>kept',
            '<script>clipboardPayloadExecuted()</script>kept',
        ];
        let checks = 0;
        for (const html of payloads) {
            const expected = html.includes("<script>") ? "clipboardPayloadExecuted()kept" : "kept";
            const item = await extractClipboardData(clipboardItem({ "text/html": html }));
            const items = await extractDataTransferItems(transfer({ "text/html": html }).items);
            const pasted = await extractAllClipboardData(new ClipboardEvent("paste", { clipboardData: transfer({ "text/html": html }) }));
            check(item?.text === expected, `ClipboardItem HTML text: ${html}`);
            check(items.length === 1 && items[0].text === expected, `DataTransfer HTML text: ${html}`);
            check(pasted.length === 1 && pasted[0].text === expected, `ClipboardEvent paste entry point: ${html}`);
            checks += 3;
        }
        await browserBarrier();
        check(!state.executed, "HTML clipboard content executed JavaScript");
        const text = "é雪🙂\nline two\t& <literal>";
        const html = "<b>é雪🙂</b>\nline two\t&amp; &lt;literal&gt;";
        check((await extractClipboardData(clipboardItem({ "text/html": html })))?.text === text, "HTML Unicode/multiline text");
        check((await extractDataTransferItems(transfer({ "text/html": html }).items))[0]?.text === text, "DataTransfer Unicode/multiline text");
        check((await extractClipboardData(clipboardItem({ "text/html": payloads[0], "text/plain": text })))?.text === text, "Plain text takes priority over HTML");
        check((await extractDataTransferItems(transfer({ "text/html": payloads[0], "text/plain": text }).items))[0]?.text === text, "DataTransfer plain text takes priority");
        check(await extractClipboardData(clipboardItem({ "text/html": "" })) === null, "Empty HTML clipboard");
        check((await extractDataTransferItems(transfer({ "text/html": "" }).items)).length === 0, "Empty HTML transfer");
        check(await extractClipboardData(clipboardItem({ "text/plain": "", "text/html": "fallback must not win" })) === null, "Empty plain text retains priority");
        check((await extractDataTransferItems(transfer({ "text/plain": "", "text/html": "fallback must not win" }).items)).length === 0, "Empty transfer plain text retains priority");
        check(await extractClipboardData(clipboardItem({})) === null, "Unsupported clipboard item");
        check((await extractDataTransferItems(new DataTransfer().items)).length === 0, "Empty transfer");
        const image = new File(["image bytes"], "paste.png", { type: "image/png" });
        const second = new File(["second image"], "second.png", { type: "image/png" });
        check((await extractClipboardData(clipboardItem({ "text/plain": text, "image/png": image })))?.image === image, "Clipboard image takes priority");
        const images = await extractDataTransferItems(transfer({ "text/plain": text, "text/html": payloads[0] }, [image, second]).items);
        check(images.length === 2 && images[0].image?.size === image.size && images[1].image?.size === second.size, "All transferred images retain precedence and order");
        const generic = await extractClipboardData(clipboardItem({ "": text }));
        check(generic?.text === text, "Generic clipboard text fallback");
        await browserBarrier();
        check(!state.executed, "A lower-priority HTML representation executed");
        return { checks: checks + 13, paths: ["ClipboardItem fixture", "native DataTransfer", "ClipboardEvent paste entry point"], unicode: true, multiline: true, plainTextPriority: true, imagePriority: true };
    },
});
