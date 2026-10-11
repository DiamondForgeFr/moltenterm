// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Streamdown pulls shiki, katex and mermaid. It loads with the first AI or onboarding message that renders; until
// then the message shows as plain text, so it is readable at once and does not jump much when formatting lands.

import type * as WaveStreamdownModule from "@/app/element/streamdown";
import { cn } from "@/util/util";
import { ComponentProps, lazy, Suspense } from "react";

const LazyStreamdown = lazy(() => import("@/app/element/streamdown").then((m) => ({ default: m.WaveStreamdown })));

type WaveStreamdownProps = ComponentProps<typeof WaveStreamdownModule.WaveStreamdown>;

export function WaveStreamdown(props: WaveStreamdownProps) {
    return (
        <Suspense
            fallback={
                <div
                    className={cn("wave-streamdown text-secondary whitespace-pre-wrap", props.className)}
                    data-testid="lazy-streamdown-loading"
                >
                    {props.text}
                </div>
            }
        >
            <LazyStreamdown {...props} />
        </Suspense>
    );
}
