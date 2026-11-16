// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/util/util";
import type { ReactNode } from "react";

export type PageAddressCopy = {
    copied: boolean;
    copyLabel: string;
    copiedLabel: string;
    onCopy: () => void;
};

// The page's address and its "Copy link" button side by side (FR-SHELL-051, #2322). The button is the address
// button's sibling with a slot of its own, never laid over it: a click on the address opens the top field, and only
// the icon after it copies. The slot exists while the button is hidden, so showing it on hover or focus moves nothing;
// "Link copied" widens it for a moment and the address gives that room up, as it does first in a narrow panel.
export function PageAddressFrame({ children, copy }: { children: ReactNode; copy: PageAddressCopy }) {
    return (
        <div className="group flex h-6 min-w-0 shrink items-center gap-0.5">
            {children}
            {copy != null ? (
                <>
                    <button
                        type="button"
                        aria-label={copy.copied ? copy.copiedLabel : copy.copyLabel}
                        title={copy.copied ? copy.copiedLabel : copy.copyLabel}
                        data-testid="browser-address-copy"
                        data-copied={copy.copied ? "true" : "false"}
                        onClick={copy.onCopy}
                        className={cn(
                            "flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-6 text-11 text-secondary hover:bg-hover hover:text-primary focus-visible:opacity-100",
                            copy.copied
                                ? "min-w-6 whitespace-nowrap px-1.5 opacity-100"
                                : "pointer-events-none w-6 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                        )}
                    >
                        <i className={cn("fa fa-solid text-12", copy.copied ? "fa-check" : "fa-copy")} />
                        {copy.copied ? <span>{copy.copiedLabel}</span> : null}
                    </button>
                    <span role="status" className="sr-only">
                        {copy.copied ? copy.copiedLabel : ""}
                    </span>
                </>
            ) : null}
        </div>
    );
}
