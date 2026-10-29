// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The new-workspace template as the windows read it (FR-SHELL-092), for the surfaces that offer its views to a
// workspace that has none (FR-SHELL-110): the first run's summary and the empty workspace.

import { getSettingsKeyAtom } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { NewWorkspaceViewsKey, readTemplate, TemplateView, templateViewName } from "./workspace-views-model";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type ListFormatter = { format: (items: string[]) => string };

export function useTemplateViews(): TemplateView[] {
    const value = useAtomValue(getSettingsKeyAtom(NewWorkspaceViewsKey as keyof SettingsType));
    return useMemo(() => readTemplate(value), [value]);
}

// "Scoping and Control room", in the interface language's way of listing.
export function templateViewsText(views: TemplateView[], tr: Translate, locale: string): string {
    const names = views.map((v) => templateViewName(v, tr));
    try {
        // Intl.ListFormat is in Chromium; the project's TypeScript lib predates it.
        const ListFormat = (Intl as unknown as { ListFormat: new (locale: string, opts: object) => ListFormatter })
            .ListFormat;
        return new ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
    } catch {
        return names.join(", ");
    }
}
