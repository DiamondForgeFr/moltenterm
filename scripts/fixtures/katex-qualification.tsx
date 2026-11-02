// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import React from "react";
import { createRoot } from "react-dom/client";
import { WaveStreamdown } from "../../frontend/app/element/streamdown";
import mermaid from "mermaid";

const root = createRoot(document.getElementById("root")!);
const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for rendered math or diagram: ${document.getElementById("root")?.innerHTML.slice(0, 1500)}`);
};

async function render(text: string, selector: string): Promise<HTMLElement> {
    root.render(<WaveStreamdown text={text} parseIncompleteMarkdown={false} />);
    await waitFor(() => !!document.querySelector(selector));
    return document.getElementById("root")!;
}

async function runChecks() {
    const math = await render("$$\\frac{1}{2}$$", ".wave-streamdown p span");
    if (!math.textContent?.includes("frac")) throw new Error("Streamdown math missing formula");
    root.render(<WaveStreamdown text={"unsafe-marker\n\n$$\n\\href{javascript:alert(1)}{unsafe}\n$$"} parseIncompleteMarkdown={false} />);
    await waitFor(() => document.getElementById("root")!.textContent!.includes("unsafe-marker"));
    if (document.querySelector('a[href^="javascript:"]')) throw new Error("Streamdown exposed unsafe URL");
    root.render(<WaveStreamdown text={"[valid link](https://example.invalid/path)"} parseIncompleteMarkdown={false} />);
    await waitFor(() => !!document.querySelector('a[href="https://example.invalid/path"]'));
    root.render(<WaveStreamdown text={"loop-marker\n\n$$\n\\def\\loop{\\loop}\\loop\n$$"} parseIncompleteMarkdown={false} />);
    await waitFor(() => document.getElementById("root")!.textContent!.includes("loop-marker"));
    await waitFor(() => document.getElementById("root")!.textContent!.includes("\\def"));
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    const diagram = await mermaid.render("mt1602-diagram", 'flowchart LR\n A["$$x^2$$"] --> B[Done]');
    if (!diagram.svg.includes("<math")) throw new Error("Mermaid math missing MathML");
    const unsafe = await mermaid.render("mt1602-unsafe", 'flowchart LR\n A["$$\\href{javascript:alert(1)}{unsafe}$$"]');
    if (/href=["']javascript:/i.test(unsafe.svg)) throw new Error("Mermaid exposed unsafe URL");
    try {
        Object.defineProperty(Object.prototype, "trust", { value: true, writable: true, configurable: true });
        const inherited = await mermaid.render("mt1602-trust", 'flowchart LR\n A["$$\\href{https://example.invalid}{unsafe}$$"]');
        if (/href=["']https:\/\/example\.invalid/i.test(inherited.svg)) throw new Error("Mermaid inherited trust");
    } finally {
        delete (Object.prototype as any).trust;
    }
    let bounded = false;
    try { await mermaid.render("mt1602-loop", 'flowchart LR\n A["$$\\def\\loop{\\loop}\\loop$$"]'); }
    catch (error) { bounded = /expansion|too many/i.test(String(error)); }
    if (!bounded) throw new Error("Mermaid recursion was not rejected by the expansion limit");
    return { math: "PASS", mermaid: "PASS", unsafeUrl: "PASS", inheritedTrust: "PASS", expansionLimit: "PASS" };
}

Object.assign(window, { runKatexChecks: runChecks });
