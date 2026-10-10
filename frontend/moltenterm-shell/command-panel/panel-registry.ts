// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Providers of the command panel, registered by capability (DS-SHELL-086). A panel combining features gets every
// matching provider's sections; sections come out ordered by kind (Agent, MoltenTerm, widget, Developer), never by
// registration order, and sections sharing an id are merged (every provider can add to Developer).

import {
    CollectedPanel,
    CommandProvider,
    PanelContext,
    PanelSection,
    PanelSectionOrder,
    PanelSuggestion,
} from "./panel-types";

const Providers = new Map<string, CommandProvider>();

// Registering an id again replaces the provider (a hot reload, a test).
export function registerCommandProvider(provider: CommandProvider): () => void {
    Providers.set(provider.id, provider);
    return () => {
        if (Providers.get(provider.id) === provider) {
            Providers.delete(provider.id);
        }
    };
}

export function registeredProviders(): CommandProvider[] {
    return Array.from(Providers.values());
}

export function clearCommandProviders() {
    Providers.clear();
}

export function hasCapability(caps: Set<string>, need: string): boolean {
    if (need.endsWith(":*")) {
        const prefix = need.slice(0, -1);
        for (const cap of caps) {
            if (cap.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }
    return caps.has(need);
}

export function providerMatches(provider: CommandProvider, ctx: PanelContext): boolean {
    for (const need of provider.needs ?? []) {
        if (!hasCapability(ctx.capabilities, need)) {
            return false;
        }
    }
    if (provider.when == null) {
        return true;
    }
    try {
        return provider.when(ctx);
    } catch (e) {
        console.error("command panel provider", provider.id, e);
        return false;
    }
}

function kindIndex(kind: string): number {
    const i = PanelSectionOrder.indexOf(kind as any);
    return i < 0 ? PanelSectionOrder.length : i;
}

function compareProviders(a: CommandProvider, b: CommandProvider): number {
    return kindIndex(a.kind) - kindIndex(b.kind) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
}

// The providers that apply to a panel, in display order. A widget fallback (the Wave adapter) drops out as soon as a
// native widget provider matches, so a rewritten widget never shows its Wave items twice.
export function matchingProviders(ctx: PanelContext, providers: CommandProvider[] = registeredProviders()) {
    const matched = providers.filter((p) => providerMatches(p, ctx));
    const nativeWidget = matched.some((p) => p.kind === "widget" && !p.fallback);
    return matched.filter((p) => !(p.fallback && nativeWidget)).sort(compareProviders);
}

function safeCall<T>(provider: CommandProvider, fn: () => T, fallback: T): T {
    try {
        return fn() ?? fallback;
    } catch (e) {
        console.error("command panel provider", provider.id, e);
        return fallback;
    }
}

export function collectPanel(ctx: PanelContext, providers: CommandProvider[] = registeredProviders()): CollectedPanel {
    const sections: PanelSection[] = [];
    const byId = new Map<string, PanelSection>();
    const suggestions: PanelSuggestion[] = [];
    for (const provider of matchingProviders(ctx, providers)) {
        for (const section of safeCall(provider, () => provider.sections(ctx), [])) {
            if (section == null) {
                continue;
            }
            const kind = section.kind ?? provider.kind;
            const existing = byId.get(section.id);
            if (existing != null) {
                existing.items.push(...(section.items ?? []));
                continue;
            }
            const copy: PanelSection = { ...section, kind, items: [...(section.items ?? [])] };
            byId.set(section.id, copy);
            sections.push(copy);
        }
        if (provider.suggestions != null) {
            suggestions.push(...safeCall(provider, () => provider.suggestions(ctx), []));
        }
    }
    // Stable: inside a kind, sections keep their providers' order.
    const ordered = sections
        .map((s, i) => ({ s, i }))
        .sort((a, b) => kindIndex(a.s.kind) - kindIndex(b.s.kind) || a.i - b.i)
        .map((r) => r.s)
        .filter((s) => s.items.length > 0);
    // At most two chips: the row is for what is urgent (DS-SHELL-085).
    return { sections: ordered, suggestions: suggestions.slice(0, 2) };
}
