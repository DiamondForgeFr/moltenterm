// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Monaco (about 8 MB with its language services) loads when the first editor or diff view mounts, not with every
// tab view. monaco-react.tsx imports monaco-env.ts, which registers the workers (the TypeScript one starts only when
// a TS/JS model opens) and whose loadMonaco() the editors call on mount.

import type * as MonacoReact from "@/app/monaco/monaco-react";
import { ComponentProps, lazy, Suspense } from "react";
import { t } from "../i18n/i18n";
import { LazyViewLoading } from "./lazy-view";

const LazyCodeEditor = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoCodeEditor })));
const LazyDiffViewer = lazy(() => import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer })));

export function MonacoCodeEditor(props: ComponentProps<typeof MonacoReact.MonacoCodeEditor>) {
    return (
        <Suspense fallback={<LazyViewLoading label={t("lazy.loadingEditor")} />}>
            <LazyCodeEditor {...props} />
        </Suspense>
    );
}

export function MonacoDiffViewer(props: ComponentProps<typeof MonacoReact.MonacoDiffViewer>) {
    return (
        <Suspense fallback={<LazyViewLoading label={t("lazy.loadingDiff")} />}>
            <LazyDiffViewer {...props} />
        </Suspense>
    );
}
