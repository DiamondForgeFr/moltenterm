// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The images found in the current project's folder, for the sidebar header's icon (#1760): read once per folder for the
// session, so switching projects back and forth never reads the disk again.

import { useEffect, useState } from "react";
import { findProjectLogos } from "../workspace-project-store";

const Found = new Map<string, string[]>();
const Asking = new Map<string, Promise<string[]>>();

function logosOf(dir: string): Promise<string[]> {
    const known = Found.get(dir);
    if (known != null) {
        return Promise.resolve(known);
    }
    let asking = Asking.get(dir);
    if (asking == null) {
        asking = findProjectLogos(dir)
            .then((logos) => {
                Found.set(dir, logos ?? []);
                return logos ?? [];
            })
            .finally(() => Asking.delete(dir));
        Asking.set(dir, asking);
    }
    return asking;
}

export function useFoundLogos(dir: string): string[] {
    const [logos, setLogos] = useState<string[]>(() => Found.get(dir) ?? []);
    useEffect(() => {
        if (!dir) {
            setLogos([]);
            return;
        }
        let live = true;
        setLogos(Found.get(dir) ?? []);
        logosOf(dir)
            .then((found) => live && setLogos(found))
            .catch((e) => console.log("project logos of the header", e));
        return () => {
            live = false;
        };
    }, [dir]);
    return logos;
}

export function resetFoundLogosForTests() {
    Found.clear();
    Asking.clear();
}
