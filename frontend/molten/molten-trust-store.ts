// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the user approved, as the two files hold it (FR-MORPH-004): `<data>/molten/trust.json`, which `molten` writes
// when the user trusts a mod, and `<config>/molten/mods.json`, the enabled state. Revoking from Settings > Mods edits
// them as `molten mod untrust` does (cmd/wsh/cmd/wshcmd-molten-mods.go): the trust record goes and the mod is no
// longer enabled, and every other key of both files stays as it was. The text comes out as molten writes it (two
// spaces, a final newline), so that a file touched by both reads the same.

export type MoltenTrustRecord = {
    name?: string;
    // RFC 3339, when the user trusted the mod.
    trustedat?: string;
};

function isPlainObject(value: unknown): value is Record<string, any> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function fileText(value: unknown): string {
    return JSON.stringify(value, null, 2) + "\n";
}

// The mods the user trusted, from the parsed trust file; anything that is not a record trusts nothing.
export function trustRecordsOf(parsed: unknown): Map<string, MoltenTrustRecord> {
    const records = new Map<string, MoltenTrustRecord>();
    const map = isPlainObject(parsed) ? parsed.trusted : null;
    if (!isPlainObject(map)) {
        return records;
    }
    for (const [id, entry] of Object.entries(map)) {
        const record: MoltenTrustRecord = {};
        if (isPlainObject(entry) && typeof entry.name === "string") {
            record.name = entry.name;
        }
        if (isPlainObject(entry) && typeof entry.trustedat === "string") {
            record.trustedat = entry.trustedat;
        }
        records.set(id, record);
    }
    return records;
}

// The trust file without the mod's record, or null when it holds none (nothing to write).
export function forgetTrust(parsed: unknown, id: string): string | null {
    if (
        !isPlainObject(parsed) ||
        !isPlainObject(parsed.trusted) ||
        !Object.prototype.hasOwnProperty.call(parsed.trusted, id)
    ) {
        return null;
    }
    const { [id]: _forgotten, ...kept } = parsed.trusted;
    return fileText({ ...parsed, trusted: kept });
}

// The state file with the mod no longer enabled, or null when it was not (nothing to write). Its "enabledat" stamp
// goes with it, as molten drops the stamps of the mods that are not enabled.
export function disableInState(parsed: unknown, id: string): string | null {
    if (!isPlainObject(parsed) || !Array.isArray(parsed.enabled) || !parsed.enabled.includes(id)) {
        return null;
    }
    const next: Record<string, any> = { ...parsed, enabled: parsed.enabled.filter((enabledId) => enabledId !== id) };
    if (isPlainObject(parsed.enabledat)) {
        const { [id]: _stamp, ...stamps } = parsed.enabledat;
        if (Object.keys(stamps).length > 0) {
            next.enabledat = stamps;
        } else {
            delete next.enabledat;
        }
    }
    return fileText(next);
}

// "4 Nov 2026" in the interface language; the zone is the machine's unless a test pins it.
export function formatTrustDate(iso: string, locale: string, timeZone?: string): string {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) {
        return "";
    }
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(when);
}
