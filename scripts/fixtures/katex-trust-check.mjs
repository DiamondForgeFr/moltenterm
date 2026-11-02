// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";

const processor = unified().use(remarkParse).use(remarkMath).use(remarkRehype).use(rehypeKatex);
const tree = processor.parse("$$\n\\href{https://example.invalid}{unsafe}\n$$");
try {
    Object.defineProperty(Object.prototype, "trust", { value: true, configurable: true, writable: true });
    const result = JSON.stringify(await processor.run(tree));
    assert.match(result, /"katex"/);
    assert.doesNotMatch(result, /katex-error/);
    assert.doesNotMatch(result, /"href":"https:\/\/example\.invalid"/);
} finally {
    delete Object.prototype.trust;
}
