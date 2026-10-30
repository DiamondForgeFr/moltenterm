// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import { VFile } from "vfile";

const require = createRequire(import.meta.url);
const consumers = ["mermaid", "streamdown", "rehype-katex", "micromark-extension-math"];

describe("qualified KaTeX consumer graph", () => {
    it("resolves every consumer to the patched exact version", () => {
        const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
        const copies = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/katex$/.test(name));
        expect(copies.length).toBe(1);
        expect((copies[0][1] as { version: string }).version).toBe("0.18.10");
        for (const consumer of consumers) {
            const from = createRequire(require.resolve(consumer));
            expect(from("katex/package.json").version, consumer).toBe("0.18.10");
        }
    });

    it("does not inherit trust in the real rehype-katex consumer", () => {
        const result = spawnSync(process.execPath, ["scripts/fixtures/katex-trust-check.mjs"], { encoding: "utf8", timeout: 60000 });
        expect(result.status, result.stderr).toBe(0);
    }, 70000);

    it("keeps recursive expansion bounded for each resolved KaTeX", () => {
        for (const consumer of consumers) {
            const from = createRequire(require.resolve(consumer));
            const katex = from("katex");
            expect(() => katex.renderToString("\\def\\loop{\\loop}\\loop", { maxExpand: 20 })).toThrow(/expansion|too many/i);
        }
    });

    it("rejects a recursive expression through the Streamdown math consumer", async () => {
        const processor = unified().use(remarkParse).use(remarkMath).use(remarkRehype).use(rehypeKatex);
        const file = new VFile();
        const tree = processor.parse("$$\n\\def\\loop{\\loop}\\loop\n$$");
        await processor.run(tree, file);
        expect(file.messages.some((message) => /expansion|too many/i.test(String(message.cause)))).toBe(true);
    });
});
