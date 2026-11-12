// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// His answers in his talk window, as Markdown (FR-BOSS-009 AC89, DS-BOSS-013, #2285): paragraphs, lists, emphasis,
// inline code and code blocks, quotes, headings drawn as strong lines, tables and rules, for reading comfort. His
// answers are data (FR-BOSS-010 security rationale): raw HTML is never interpreted, an image shows as its text, and a
// link shows its text and its address without being a click target. react-markdown and remark-gfm already come with
// Wave's own Markdown in the bundle every view loads.

import { ReactNode } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// What his Markdown may draw; anything else gives way to its content (unwrapDisallowed).
export const AllowedElements = [
    "p",
    "br",
    "strong",
    "em",
    "del",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "a",
    "img",
];

function textOf(node: ReactNode): string {
    if (node == null || typeof node === "boolean") {
        return "";
    }
    if (typeof node === "string" || typeof node === "number") {
        return String(node);
    }
    if (Array.isArray(node)) {
        return node.map(textOf).join("");
    }
    return textOf((node as { props?: { children?: ReactNode } }).props?.children);
}

// A heading is a strong line of his answer, not a title of the window.
function Heading({ children }: { children?: ReactNode }) {
    return <p className="mt-brokk-md-h">{children}</p>;
}

const MarkdownComponents: Components = {
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    h5: Heading,
    h6: Heading,
    // Its text, and its address when the text does not say it: nothing to click.
    a: ({ href, children }) => {
        const label = textOf(children);
        const address = href ?? "";
        return (
            <span className="mt-brokk-md-link" data-testid="brokk-md-link">
                {children}
                {address !== "" && address !== label ? <span className="mt-brokk-md-href"> ({address})</span> : null}
            </span>
        );
    },
    // Never loaded: an image shows as its text.
    img: ({ alt }) => (alt ? <span className="mt-brokk-md-img">[{alt}]</span> : null),
};

type MdNode = { type: string; children?: MdNode[] };

// Raw HTML in his answer shows as the text he wrote, never as markup.
function htmlAsText() {
    const walk = (node: MdNode) => {
        if (node.type === "html") {
            node.type = "text";
        }
        node.children?.forEach(walk);
    };
    return (tree: MdNode) => walk(tree);
}

export function BrokkMarkdown({ text }: { text: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm, htmlAsText]}
            allowedElements={AllowedElements}
            unwrapDisallowed
            components={MarkdownComponents}
        >
            {text ?? ""}
        </ReactMarkdown>
    );
}
