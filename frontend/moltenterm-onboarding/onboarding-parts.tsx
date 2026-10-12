// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Small pieces the first run's steps share: inline code, and a line of text to copy.

import { getApi } from "@/app/store/global";
import { cn } from "@/util/util";
import { useEffect, useState } from "react";

const CopiedMs = 2000;

export function Code({ children }: { children: React.ReactNode }) {
    return <code className="rounded-4 bg-line-strong px-1 font-mono text-12 text-primary">{children}</code>;
}

export function StepText({ children, className }: { children: React.ReactNode; className?: string }) {
    return <p className={cn("text-13 leading-5 text-secondary", className)}>{children}</p>;
}

export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <a
            href={href}
            onClick={(e) => {
                e.preventDefault();
                getApi().openExternal(href);
            }}
            className="cursor-pointer text-accent hover:underline"
        >
            {children}
        </a>
    );
}

// The text in mono, with a Copy button that says Copied for a moment.
export function CopyLine({ text, testId }: { text: string; testId?: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) {
            return;
        }
        const timer = setTimeout(() => setCopied(false), CopiedMs);
        return () => clearTimeout(timer);
    }, [copied]);
    const copy = () => {
        navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch((e) => console.log("first run: copy failed", e));
    };
    return (
        <div className="flex items-center gap-2 rounded-4 border border-border py-1 pr-1 pl-2.5">
            <code className="min-w-0 flex-1 font-mono text-12 break-words text-primary" data-testid={testId}>
                {text}
            </code>
            <button
                type="button"
                onClick={copy}
                className="molten-btn-secondary shrink-0 cursor-pointer rounded-6 px-2 py-1 text-12"
            >
                <i className={cn("fa-solid mr-1.5", copied ? "fa-check" : "fa-copy")} aria-hidden />
                {copied ? "Copied" : "Copy"}
            </button>
        </div>
    );
}
