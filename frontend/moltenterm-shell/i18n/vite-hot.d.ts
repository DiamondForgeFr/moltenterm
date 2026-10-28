// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The part of Vite's HMR client the dictionaries use (#1215); undefined outside the dev server.
interface ImportMeta {
    readonly hot?: {
        on(event: string, callback: (data: any) => void): void;
    };
}
