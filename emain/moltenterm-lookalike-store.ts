// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the lookalike warning keeps in the application's own data folder (#2482, FR-BRW-024, DS-BRW-029): the domains
// the developer chose to continue to, and how many times they opened each domain, which makes a domain "frequent" and so
// one a lookalike is compared with. Domains and counts only, never an address, never what a page held. Only Electron main
// writes these files, on a request of the application's window, so neither a terminal's setconfig nor an agent reaches
// them. Kept apart from Electron so the rules are tested alone.

import * as fs from "node:fs";
import * as path from "node:path";
import { registrableDomain } from "../frontend/moltenterm-shell/browser/lookalike";

const AllowedFile = "lookalike-allowed.json";
const VisitsFile = "lookalike-visits.json";

// A domain opened this many times is one the developer knows.
export const FrequentVisits = 3;
export const MaxAllowed = 2000;
export const MaxVisited = 500;
const FlushDelayMs = 5000;

type VisitEntry = { count: number; last: number };

function readJson(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function writeJson(file: string, value: unknown): void {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
}

export class LookalikeStore {
    private allowedDomains = new Set<string>();
    private visits = new Map<string, VisitEntry>();
    private timer: ReturnType<typeof setTimeout> = null;
    private dirty = false;

    constructor(
        private dir: string,
        private now: () => number = Date.now
    ) {
        this.load();
    }

    private load(): void {
        const allowed = readJson(path.join(this.dir, AllowedFile));
        if (Array.isArray(allowed)) {
            for (const entry of allowed.slice(0, MaxAllowed)) {
                const domain = typeof entry === "string" ? registrableDomain(entry) : null;
                if (domain != null) {
                    this.allowedDomains.add(domain);
                }
            }
        }
        const visits = readJson(path.join(this.dir, VisitsFile));
        if (visits != null && typeof visits === "object" && !Array.isArray(visits)) {
            for (const [name, raw] of Object.entries(visits as Record<string, any>).slice(0, MaxVisited)) {
                const domain = registrableDomain(name);
                const count = Number(raw?.count);
                if (domain != null && Number.isInteger(count) && count > 0) {
                    this.visits.set(domain, { count: Math.min(count, 1_000_000), last: Number(raw?.last) || 0 });
                }
            }
        }
    }

    isAllowed(domain: string): boolean {
        return this.allowedDomains.has(domain);
    }

    // The developer continued to this domain: it opens without the warning from now on.
    allow(domain: string): boolean {
        const clean = typeof domain === "string" ? registrableDomain(domain) : null;
        if (clean == null || clean !== domain) {
            return false;
        }
        if (!this.allowedDomains.has(clean)) {
            if (this.allowedDomains.size >= MaxAllowed) {
                this.allowedDomains.delete(this.allowedDomains.values().next().value);
            }
            this.allowedDomains.add(clean);
            this.visits.delete(clean);
            this.schedule();
        }
        return true;
    }

    // One more visit of a domain: true when it has just become frequent. A domain the developer continued to a warning
    // for is never counted, so a lookalike they passed does not become one they know.
    visit(domain: string): boolean {
        const clean = typeof domain === "string" ? registrableDomain(domain) : null;
        if (clean == null || clean !== domain || this.allowedDomains.has(clean)) {
            return false;
        }
        const entry = this.visits.get(clean) ?? { count: 0, last: 0 };
        entry.count += 1;
        entry.last = this.now();
        this.visits.set(clean, entry);
        if (this.visits.size > MaxVisited) {
            this.dropLeastKnown(clean);
        }
        this.schedule();
        return entry.count === FrequentVisits;
    }

    private dropLeastKnown(keep: string): void {
        let worst: string = null;
        let worstEntry: VisitEntry = null;
        for (const [domain, entry] of this.visits) {
            if (domain === keep) {
                continue;
            }
            if (
                worstEntry == null ||
                entry.count < worstEntry.count ||
                (entry.count === worstEntry.count && entry.last < worstEntry.last)
            ) {
                worst = domain;
                worstEntry = entry;
            }
        }
        if (worst != null) {
            this.visits.delete(worst);
        }
    }

    frequent(): string[] {
        return Array.from(this.visits.entries())
            .filter(([, entry]) => entry.count >= FrequentVisits)
            .map(([domain]) => domain);
    }

    private schedule(): void {
        this.dirty = true;
        if (this.timer != null) {
            return;
        }
        this.timer = setTimeout(() => this.flush(), FlushDelayMs);
        this.timer.unref?.();
    }

    // Writes what changed; also called when the application quits.
    flush(): void {
        if (this.timer != null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.dirty) {
            return;
        }
        this.dirty = false;
        try {
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            writeJson(path.join(this.dir, AllowedFile), Array.from(this.allowedDomains));
            writeJson(
                path.join(this.dir, VisitsFile),
                Object.fromEntries(Array.from(this.visits.entries()).map(([domain, entry]) => [domain, entry]))
            );
        } catch (e) {
            console.log("lookalike store: not saved", e instanceof Error ? e.message : String(e));
        }
    }
}
