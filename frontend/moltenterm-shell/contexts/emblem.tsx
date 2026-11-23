// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A context's emblem is a Lucide icon, named in kebab case, never an emoji (FR-SHELL-158). The selection the picker offers
// is emblem-catalog.ts: one chunk per icon, loaded when an emblem is drawn or the picker opens. The ones loaded stay in a
// map, so the ribbon of a window never flashes an empty slot once its emblem has been seen.

import { Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { FallbackContextEmblem } from "./context-model";

type EmblemNode = React.ComponentProps<typeof Icon>["iconNode"];

const nodes = new Map<string, EmblemNode>();

// The drawing of an emblem; a name that is not in the selection is drawn as the fallback emblem. The catalog is a chunk of
// its own, so the window's up-front JavaScript holds none of its icons (NFR-PERF-003).
export async function loadEmblem(name: string): Promise<EmblemNode> {
    const known = nodes.get(name);
    if (known != null) {
        return known;
    }
    const { EmblemCatalog } = await import("./emblem-catalog");
    const loader = EmblemCatalog[name] ?? EmblemCatalog[FallbackContextEmblem];
    const node = (await loader()).__iconNode as EmblemNode;
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
