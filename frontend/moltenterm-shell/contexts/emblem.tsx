// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A context's emblem is a Lucide icon, named in kebab case, never an emoji (FR-SHELL-158). Lucide's whole set is far
// too much to ship up front, so the catalog (its names and one loader each) and every icon are separate chunks that
// load when an emblem is drawn or the picker opens; the ones loaded stay in a map, so the ribbon of a window never
// flashes an empty slot once its emblem has been seen.

import { Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { FallbackContextEmblem } from "./context-model";

type EmblemNode = React.ComponentProps<typeof Icon>["iconNode"];
type EmblemCatalog = Record<string, () => Promise<{ __iconNode: EmblemNode }>>;

const nodes = new Map<string, EmblemNode>();
let catalogLoad: Promise<EmblemCatalog> = null;

export function loadEmblemCatalog(): Promise<EmblemCatalog> {
    catalogLoad ??= import("lucide-react/dynamicIconImports").then((m) => m.default as unknown as EmblemCatalog);
    return catalogLoad;
}

// The names the picker lists, sorted as the catalog sorts them.
export async function loadEmblemNames(): Promise<string[]> {
    return Object.keys(await loadEmblemCatalog());
}

// The drawing of an emblem; an unknown name is drawn as the fallback emblem.
export async function loadEmblem(name: string): Promise<EmblemNode> {
    const known = nodes.get(name);
    if (known != null) {
        return known;
    }
    const catalog = await loadEmblemCatalog();
    const loader = catalog[name] ?? catalog[FallbackContextEmblem];
    const node = (await loader()).__iconNode;
    nodes.set(name, node);
    return node;
}

export function Emblem({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
    const [node, setNode] = useState<EmblemNode>(() => nodes.get(name));
    useEffect(() => {
        const known = nodes.get(name);
        if (known != null) {
            setNode(known);
            return;
        }
        let live = true;
        loadEmblem(name)
            .then((loaded) => live && setNode(loaded))
            .catch((e) => console.log("emblem: loading", name, e));
        return () => {
            live = false;
        };
    }, [name]);
    if (node == null) {
        return <span className={className} style={{ width: size, height: size }} aria-hidden />;
    }
    return <Icon iconNode={node} size={size} className={className} aria-hidden />;
}
