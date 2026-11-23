// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Lookalike domains (#2482, FR-BRW-024, DS-BRW-029). A phishing site lives on a domain that imitates one the developer
// knows: the same name with a Cyrillic а, a 1 for an l, a letter more or less. This module decides whether the domain a
// tab is about to load imitates a known one, and how a host is shown in the address bar. Pure and local: nothing is
// fetched, no list is downloaded. emain/moltenterm-lookalike.ts holds the navigation; the panel draws the warning.

export const SourceBookmark = "bookmark";
export const SourcePinned = "pinned";
export const SourceFrequent = "frequent";
export const SourceTop = "top";
export type KnownSource = typeof SourceBookmark | typeof SourcePinned | typeof SourceFrequent | typeof SourceTop;

export const ReasonSkeleton = "skeleton";
export const ReasonDistance = "distance";

export type KnownDomain = { domain: string; source: KnownSource };

// What the warning says: the domain being opened (ASCII, registrable), the known domain it imitates and why.
export type LookalikeMatch = {
    domain: string;
    resembles: string;
    source: KnownSource;
    reason: typeof ReasonSkeleton | typeof ReasonDistance;
};

// A navigation held for a guest, as the panel shows it.
export type LookalikeHold = {
    url: string;
    host: string;
    domain: string;
    resembles: string;
    source: KnownSource;
    reason: typeof ReasonSkeleton | typeof ReasonDistance;
    agent: boolean;
};

const MaxHostChars = 253;
const MaxLabelChars = 63;

// A label of this many characters or more is one edit from the known label to count, and of this many, two edits.
const OneEditFrom = 6;
const TwoEditsFrom = 10;

// A name a visitor registers under, where the suffix is not a registry but a host that gives its customers a name below
// it: foo.github.io is foo's, not github.io's. Registries with more than one label come first.
const MultiLabelSuffixes = new Set(
    (
        "co.uk org.uk me.uk ltd.uk plc.uk net.uk gov.uk ac.uk sch.uk nhs.uk " +
        "com.au net.au org.au edu.au gov.au id.au asn.au " +
        "co.nz net.nz org.nz govt.nz ac.nz school.nz " +
        "co.jp ne.jp or.jp ac.jp go.jp ed.jp gr.jp " +
        "com.br net.br org.br gov.br edu.br " +
        "com.mx org.mx gob.mx edu.mx com.ar gob.ar com.co com.pe com.ve com.uy com.ec " +
        "com.cn net.cn org.cn gov.cn edu.cn com.hk org.hk com.sg edu.sg com.tw org.tw com.my com.ph com.vn com.id co.id " +
        "co.in net.in org.in gov.in ac.in co.kr or.kr go.kr ac.kr co.th co.il org.il " +
        "co.za org.za gov.za ac.za com.ng com.eg com.sa com.pk com.bd com.tr gov.tr org.tr edu.tr " +
        "com.ua com.ru com.pl net.pl org.pl com.pt com.es com.gr com.cy com.mt com.ro " +
        "gouv.fr asso.fr nom.fr com.fr tm.fr gouv.ci gouv.sn gouv.qc.ca"
    ).split(" ")
);
const HostingSuffixes = new Set(
    (
        "github.io gitlab.io vercel.app netlify.app herokuapp.com pages.dev workers.dev web.app firebaseapp.com " +
        "appspot.com azurewebsites.net cloudfront.net blogspot.com s3.amazonaws.com onrender.com fly.dev glitch.me " +
        "repl.co ngrok.io ngrok-free.app trycloudflare.com surge.sh now.sh myshopify.com wixsite.com weebly.com " +
        "000webhostapp.com framer.app webflow.io bubbleapps.io carrd.co notion.site"
    ).split(" ")
);

function normalizeHost(hostname: string): string {
    if (typeof hostname !== "string") {
        return null;
    }
    const host = hostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "");
    if (host === "" || host.length > MaxHostChars) {
        return null;
    }
    return host;
}

function isIpHost(host: string): boolean {
    return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export type DomainParts = { domain: string; label: string; suffix: string };

// The registrable domain of an ASCII host (its name and its public suffix), or null for an IP address, localhost, a
// single label, a numeric top label, or a host that is a suffix itself.
export function splitDomain(hostname: string): DomainParts {
    const host = normalizeHost(hostname);
    if (host == null || isIpHost(host) || host === "localhost" || host.endsWith(".localhost")) {
        return null;
    }
    const labels = host.split(".");
    if (labels.length < 2 || labels.some((l) => l === "" || l.length > MaxLabelChars)) {
        return null;
    }
    if (/^\d+$/.test(labels[labels.length - 1])) {
        return null;
    }
    let suffixLabels = 1;
    for (const count of [3, 2]) {
        const candidate = labels.slice(-count).join(".");
        if (labels.length >= count && (MultiLabelSuffixes.has(candidate) || HostingSuffixes.has(candidate))) {
            suffixLabels = count;
            break;
        }
    }
    if (labels.length <= suffixLabels) {
        return null;
    }
    const suffix = labels.slice(-suffixLabels).join(".");
    const label = labels[labels.length - suffixLabels - 1];
    return { domain: `${label}.${suffix}`, label, suffix };
}

export function registrableDomain(hostname: string): string {
    return splitDomain(hostname)?.domain ?? null;
}

// The registrable domain of a web address, null for anything else.
export function domainOfAddress(address: string): string {
    if (typeof address !== "string" || address.length > 8192) {
        return null;
    }
    try {
        const url = new URL(address);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }
        return registrableDomain(url.hostname);
    } catch {
        return null;
    }
}

// ---- Punycode (RFC 3492), to read an internationalized host the way a person would.

const PunyBase = 36;
const PunyTMin = 1;
const PunyTMax = 26;
const PunySkew = 38;
const PunyDamp = 700;
const PunyInitialBias = 72;
const PunyInitialN = 128;

function punyAdapt(delta: number, points: number, first: boolean): number {
    let d = first ? Math.floor(delta / PunyDamp) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((PunyBase - PunyTMin) * PunyTMax) >> 1) {
        d = Math.floor(d / (PunyBase - PunyTMin));
        k += PunyBase;
    }
    return k + Math.floor(((PunyBase - PunyTMin + 1) * d) / (d + PunySkew));
}

function punyDigit(code: number): number {
    if (code >= 48 && code <= 57) {
        return code - 22;
    }
    if (code >= 65 && code <= 90) {
        return code - 65;
    }
    if (code >= 97 && code <= 122) {
        return code - 97;
    }
    return PunyBase;
}

// The text of an `xn--` label after the prefix, or null when it is not valid punycode.
export function decodePunycode(input: string): string {
    const output: number[] = [];
    let basic = input.lastIndexOf("-");
    if (basic < 0) {
        basic = 0;
    }
    for (let j = 0; j < basic; j++) {
        const code = input.charCodeAt(j);
        if (code >= 0x80) {
            return null;
        }
        output.push(code);
    }
    let n = PunyInitialN;
    let i = 0;
    let bias = PunyInitialBias;
    for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
        const oldi = i;
        let w = 1;
        for (let k = PunyBase; ; k += PunyBase) {
            if (index >= input.length) {
                return null;
            }
            const digit = punyDigit(input.charCodeAt(index++));
            if (digit >= PunyBase) {
                return null;
            }
            i += digit * w;
            if (!Number.isSafeInteger(i)) {
                return null;
            }
            const t = k <= bias ? PunyTMin : k >= bias + PunyTMax ? PunyTMax : k - bias;
            if (digit < t) {
                break;
            }
            w *= PunyBase - t;
        }
        const count = output.length + 1;
        bias = punyAdapt(i - oldi, count, oldi === 0);
        n += Math.floor(i / count);
        i %= count;
        if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
            return null;
        }
        output.splice(i++, 0, n);
    }
    return String.fromCodePoint(...output);
}

// The host with its `xn--` labels read as text. A label that does not decode stays as it is.
export function unicodeHost(hostname: string): string {
    const host = normalizeHost(hostname);
    if (host == null) {
        return "";
    }
    return host
        .split(".")
        .map((label) => (label.startsWith("xn--") ? (decodePunycode(label.slice(4)) ?? label) : label))
        .join(".");
}

// Any label is internationalized, in either form.
export function isIdnHost(hostname: string): boolean {
    const host = normalizeHost(hostname);
    if (host == null) {
        return false;
    }
    return /[^\x20-\x7e]/.test(host) || host.split(".").some((label) => label.startsWith("xn--"));
}

// The host in ASCII, as the URL parser spells it.
export function asciiHost(hostname: string): string {
    const host = normalizeHost(hostname);
    if (host == null) {
        return null;
    }
    try {
        return new URL(`http://${host}/`).hostname;
    } catch {
        return null;
    }
}

// ---- Skeletons: what a domain can be mistaken for.

const ConfusablePairs: [string, string][] = [
    // Cyrillic
    ["а", "a"],
    ["с", "c"],
    ["е", "e"],
    ["һ", "h"],
    ["і", "i"],
    ["ј", "j"],
    ["к", "k"],
    ["о", "o"],
    ["р", "p"],
    ["ѕ", "s"],
    ["у", "y"],
    ["х", "x"],
    ["ԁ", "d"],
    ["ԛ", "q"],
    ["ԝ", "w"],
    ["ӏ", "l"],
    // Greek
    ["α", "a"],
    ["ο", "o"],
    ["ρ", "p"],
    ["ν", "v"],
    ["ι", "i"],
    ["κ", "k"],
    ["χ", "x"],
    ["ϲ", "c"],
    ["ϳ", "j"],
    // Armenian
    ["օ", "o"],
    ["ս", "u"],
    ["ո", "n"],
    ["հ", "h"],
    // Latin letters outside the ASCII range
    ["ɑ", "a"],
    ["ɡ", "g"],
    ["ı", "i"],
    ["ɩ", "i"],
    ["ȷ", "j"],
    ["ø", "o"],
    ["ł", "l"],
    ["đ", "d"],
    ["ħ", "h"],
    ["ŧ", "t"],
    ["ʟ", "l"],
    ["ɴ", "n"],
    ["ᴏ", "o"],
    ["ᴘ", "p"],
    ["ᴜ", "u"],
    ["ᴠ", "v"],
    ["ᴡ", "w"],
    ["ᴢ", "z"],
    ["ᴄ", "c"],
    ["ᴅ", "d"],
    ["ᴇ", "e"],
    ["ɢ", "g"],
    ["ʜ", "h"],
    ["ᴊ", "j"],
    ["ᴋ", "k"],
    ["ᴍ", "m"],
    ["ʀ", "r"],
    ["ᴛ", "t"],
    ["ʏ", "y"],
    ["ꜱ", "s"],
    // Shapes that read as one another in a domain: 0 and o, 1, i and l.
    ["0", "o"],
    ["1", "l"],
    ["i", "l"],
];
const Confusables = new Map<string, string>(ConfusablePairs);
const CombiningMarks = /\p{M}/gu;

// The domain with every character that can pass for another folded to one (NFKC, lower case, no accents, the table
// above), and the pairs that read as one letter folded too: rn for m, vv for w.
export function skeleton(text: string): string {
    const folded = (text ?? "").normalize("NFKC").toLowerCase().normalize("NFD").replace(CombiningMarks, "");
    let out = "";
    for (const ch of folded) {
        out += Confusables.get(ch) ?? ch;
    }
    return out.replace(/rn/g, "m").replace(/vv/g, "w");
}

// Optimal string alignment distance: an insertion, a deletion, a substitution or the swap of two neighbours is one edit.
// Labels are at most 63 characters, so the whole table is cheap; a length gap past max is answered at once.
export function editDistance(a: string, b: string, max: number): number {
    const x = Array.from(a);
    const y = Array.from(b);
    if (Math.abs(x.length - y.length) > max) {
        return max + 1;
    }
    let prev2: number[] = [];
    let prev: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
        const row: number[] = [i];
        for (let j = 1; j <= y.length; j++) {
            const cost = x[i - 1] === y[j - 1] ? 0 : 1;
            let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
            if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
                value = Math.min(value, prev2[j - 2] + 1);
            }
            row.push(value);
        }
        prev2 = prev;
        prev = row;
    }
    return prev[y.length];
}

// How many edits make a label a typo of another: none under 6 characters (too many real names sit that close), one
// from 6, two from 10.
export function editsAllowed(longerLabelLength: number): number {
    if (longerLabelLength >= TwoEditsFrom) {
        return 2;
    }
    return longerLabelLength >= OneEditFrom ? 1 : 0;
}

type Indexed = {
    domain: string;
    source: KnownSource;
    suffix: string;
    label: string;
    labelSkeleton: string;
    skeleton: string;
};

// The known domains, ready to compare with a host. The developer's own come before the bundled list, so a domain that
// is on both names the developer's.
export class LookalikeIndex {
    private entries: Indexed[] = [];
    private domains = new Set<string>();

    constructor(known: readonly KnownDomain[]) {
        for (const entry of known) {
            const parts = splitDomain(asciiHost(entry?.domain));
            if (parts == null || this.domains.has(parts.domain)) {
                continue;
            }
            this.domains.add(parts.domain);
            this.entries.push({
                domain: parts.domain,
                source: entry.source,
                suffix: parts.suffix,
                label: unicodeHost(parts.label),
                labelSkeleton: skeleton(unicodeHost(parts.label)),
                skeleton: skeleton(unicodeHost(parts.domain)),
            });
        }
    }

    size(): number {
        return this.entries.length;
    }

    knows(domain: string): boolean {
        return this.domains.has(domain);
    }

    // The known domain the host imitates, or null: the host's own domain, its subdomains and every domain that is itself
    // known never match, and IP addresses, localhost and single labels are not checked.
    find(hostname: string): LookalikeMatch {
        const parts = splitDomain(asciiHost(hostname));
        if (parts == null || this.domains.has(parts.domain)) {
            return null;
        }
        const label = unicodeHost(parts.label);
        const labelSkeleton = skeleton(label);
        const candidate = skeleton(unicodeHost(parts.domain));
        let nearest: LookalikeMatch = null;
        let nearestEdits = Infinity;
        for (const known of this.entries) {
            if (known.skeleton === candidate) {
                return { domain: parts.domain, resembles: known.domain, source: known.source, reason: ReasonSkeleton };
            }
            if (known.suffix !== parts.suffix) {
                continue;
            }
            const allowed = editsAllowed(Math.max(Array.from(label).length, Array.from(known.label).length));
            if (allowed === 0) {
                continue;
            }
            // An edit and a lookalike letter together (paypa11.com) are the same trick twice.
            const edits = Math.min(
                editDistance(label, known.label, allowed),
                editDistance(labelSkeleton, known.labelSkeleton, allowed)
            );
            if (edits <= allowed && edits < nearestEdits) {
                nearestEdits = edits;
                nearest = {
                    domain: parts.domain,
                    resembles: known.domain,
                    source: known.source,
                    reason: ReasonDistance,
                };
            }
        }
        return nearest;
    }
}

// ---- How a host is shown.

const ScriptTests: [string, RegExp][] = [
    ["Latin", /\p{Script=Latin}/u],
    ["Cyrillic", /\p{Script=Cyrillic}/u],
    ["Greek", /\p{Script=Greek}/u],
    ["Armenian", /\p{Script=Armenian}/u],
    ["Hebrew", /\p{Script=Hebrew}/u],
    ["Arabic", /\p{Script=Arabic}/u],
    ["Han", /\p{Script=Han}/u],
    ["Hiragana", /\p{Script=Hiragana}/u],
    ["Katakana", /\p{Script=Katakana}/u],
    ["Hangul", /\p{Script=Hangul}/u],
    ["Bopomofo", /\p{Script=Bopomofo}/u],
    ["Thai", /\p{Script=Thai}/u],
    ["Devanagari", /\p{Script=Devanagari}/u],
    ["Georgian", /\p{Script=Georgian}/u],
];
const NeutralScripts = /[\p{Script=Common}\p{Script=Inherited}]/u;
// Han with the scripts it is written with in Japanese, Chinese and Korean is one script for a name.
const CjkCombinations: string[][] = [
    ["Han", "Hiragana", "Katakana"],
    ["Han", "Bopomofo"],
    ["Han", "Hangul"],
];

function scriptOf(ch: string): string {
    if (NeutralScripts.test(ch)) {
        return null;
    }
    return ScriptTests.find(([, test]) => test.test(ch))?.[0] ?? "Other";
}

// A label that writes in more than one script (Latin with Cyrillic): the classic disguise.
export function labelMixesScripts(label: string): boolean {
    const scripts = new Set<string>();
    for (const ch of label) {
        const script = scriptOf(ch);
        if (script != null) {
            scripts.add(script);
        }
    }
    if (scripts.size <= 1) {
        return false;
    }
    return !CjkCombinations.some((combination) => Array.from(scripts).every((s) => combination.includes(s)));
}

// What the address bar shows for a host: its `xn--` form when a label mixes scripts or the host was flagged (the
// developer must see what the host really is), else its text.
export function shownHost(hostname: string, flagged = false): string {
    const ascii = asciiHost(hostname);
    if (ascii == null) {
        return typeof hostname === "string" ? hostname : "";
    }
    if (!isIdnHost(ascii)) {
        return ascii;
    }
    const text = unicodeHost(ascii);
    if (flagged || text.split(".").some(labelMixesScripts)) {
        return ascii;
    }
    return text;
}

const AuthorityPattern = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i;

// A web address with its host shown as shownHost says. Anything that is not a web address comes back as it is.
export function shownAddressHost(address: string, flagged = false): string {
    const match = typeof address === "string" ? AuthorityPattern.exec(address) : null;
    if (match == null || !/^https?:\/\//i.test(match[1])) {
        return address;
    }
    const authority = match[2];
    const at = authority.lastIndexOf("@");
    const hostPort = authority.slice(at + 1);
    const portAt = /:\d*$/.exec(hostPort);
    const host = portAt == null ? hostPort : hostPort.slice(0, portAt.index);
    if (host === "" || host.startsWith("[") || !isIdnHost(host)) {
        return address;
    }
    const shown = shownHost(host, flagged);
    return match[1] + authority.slice(0, at + 1) + shown + (portAt?.[0] ?? "") + address.slice(match[0].length);
}

function isTextArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const MaxKnownAddresses = 2000;
const MaxAddressChars = 2048;

// What the window sends: addresses of its bookmarks and pinned sites, reduced to registrable domains and bounded. The
// sender is the application's own window, but the list still crosses a process boundary.
export function knownDomainsFrom(value: unknown, source: KnownSource): KnownDomain[] {
    if (!isTextArray(value)) {
        return [];
    }
    const seen = new Set<string>();
    const out: KnownDomain[] = [];
    for (const address of value.slice(0, MaxKnownAddresses)) {
        const domain = address.length <= MaxAddressChars ? domainOfAddress(address) : null;
        if (domain != null && !seen.has(domain)) {
            seen.add(domain);
            out.push({ domain, source });
        }
    }
    return out;
}

export function isLookalikeHold(value: any): value is LookalikeHold {
    return (
        value != null &&
        typeof value === "object" &&
        typeof value.url === "string" &&
        typeof value.host === "string" &&
        typeof value.domain === "string" &&
        typeof value.resembles === "string" &&
        typeof value.source === "string" &&
        typeof value.reason === "string" &&
        typeof value.agent === "boolean"
    );
}

// ---- How a lookalike differs from the domain it imitates, in a few words for the warning.

export const DifferenceDigit = "digit";
export const DifferenceScript = "script";
export const DifferenceSwapped = "swapped";
export const DifferenceExtra = "extra";
export const DifferenceMissing = "missing";
export const DifferenceSubstitute = "substitute";
export const DifferenceGeneric = "generic";

export type Difference = {
    kind: string;
    // from, to, char, pair or script, whichever the kind says; the script is a name from scriptNameOf.
    vars: Record<string, string>;
};

// The script a character is written in ("Latin", "Cyrillic"...), null for digits, hyphens and other neutral characters.
export function scriptNameOf(ch: string): string {
    return scriptOf(ch);
}

// What sets two domains apart when they are close: the text between their common start and common end, read as a digit
// for a letter, a letter of another script, a letter more or less, two letters swapped, or a short substitution.
export function describeDifference(candidate: string, known: string): Difference {
    const x = Array.from(unicodeHost(candidate));
    const y = Array.from(unicodeHost(known));
    const limit = Math.min(x.length, y.length);
    let start = 0;
    while (start < limit && x[start] === y[start]) {
        start++;
    }
    let end = 0;
    while (end < limit - start && x[x.length - 1 - end] === y[y.length - 1 - end]) {
        end++;
    }
    const a = x.slice(start, x.length - end).join("");
    const b = y.slice(start, y.length - end).join("");
    const ac = Array.from(a);
    const bc = Array.from(b);
    if (ac.length === 0 && bc.length === 1) {
        return { kind: DifferenceMissing, vars: { char: b } };
    }
    if (bc.length === 0 && ac.length === 1) {
        return { kind: DifferenceExtra, vars: { char: a } };
    }
    if (ac.length === 2 && bc.length === 2 && ac[0] === bc[1] && ac[1] === bc[0]) {
        return { kind: DifferenceSwapped, vars: { pair: a } };
    }
    if (ac.length === 1 && bc.length === 1) {
        if (/\d/.test(a)) {
            return { kind: DifferenceDigit, vars: { from: a, to: b } };
        }
        const script = scriptNameOf(a);
        if (script != null && script !== "Latin") {
            return { kind: DifferenceScript, vars: { script, from: a, to: b } };
        }
        return { kind: DifferenceSubstitute, vars: { from: a, to: b } };
    }
    if (ac.length >= 1 && ac.length <= 2 && bc.length >= 1 && bc.length <= 2) {
        return { kind: DifferenceSubstitute, vars: { from: a, to: b } };
    }
    return { kind: DifferenceGeneric, vars: {} };
}
