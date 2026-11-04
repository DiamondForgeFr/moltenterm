// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release signature check of the in-app update (#1860): SHA256SUMS.txt.asc is a detached OpenPGP signature made by
// the DiamondForge release key (#576, scripts/moltenterm-release-sign.sh). The key is an Ed25519 key and the app has
// node:crypto, so the check is these few packets rather than a dependency: a public key packet (RFC 4880 5.5.2, the
// "EdDSA legacy" form GnuPG writes, algorithm 22), and a version 4 signature over a binary document (5.2.4). Anything
// else (another key type or version, a text signature, a weak hash) is refused as unsupported, never guessed at.
// Pure: no Electron, no network, no clock but the one passed in.

import { createHash, createPublicKey, KeyObject, verify } from "crypto";

const TagSignature = 2;
const TagPublicKey = 6;
const TagPublicSubkey = 14;
const AlgorithmEdDsa = 22;
const SignatureVersion = 4;
const SignatureTypeBinary = 0x00;
// The certification types a key's self-signatures use (RFC 4880 5.2.1): they carry the key's expiration time.
const CertificationTypes = new Set([0x10, 0x11, 0x12, 0x13]);
const SubpacketCreated = 2;
const SubpacketSignatureExpires = 3;
const SubpacketKeyExpires = 9;
const SubpacketIssuerKeyId = 16;
const SubpacketIssuerFingerprint = 33;
// 1.3.6.1.4.1.11591.15.1, the curve OID of Ed25519 in OpenPGP's legacy form.
const Ed25519Oid = Buffer.from("2b06010401da470f01", "hex");
// Sha1 and Sha224 are not accepted: a signature that weak proves nothing.
const HashAlgorithms: Record<number, string> = { 8: "sha256", 9: "sha384", 10: "sha512" };

export type ReleaseKey = {
    // 40 upper-case hex digits.
    fingerprint: string;
    keyId: string;
    // Seconds since the epoch.
    created: number;
    // Seconds after creation, or null for a key that never expires.
    expiresAfter: number;
    publicKey: KeyObject;
};

// Why a signature is refused. The caller turns each into a sentence.
export type SignatureFailure = "unreadable" | "unsupported" | "wrongkey" | "badtime" | "expired" | "bad";

export type SignatureResult = { ok: true; signedAt: number } | { ok: false; reason: SignatureFailure };

type Packet = { tag: number; body: Buffer };

class Unreadable extends Error {}

// The bytes of an ASCII-armoured block (RFC 4880 6.2). The CRC line is not checked: the signature itself is.
export function dearmor(text: string): Buffer {
    const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
    const begin = lines.findIndex((l) => /^-----BEGIN PGP [A-Z ]+-----\s*$/.test(l));
    if (begin < 0) {
        throw new Unreadable("no armoured block");
    }
    let i = begin + 1;
    while (i < lines.length && lines[i].trim() !== "") {
        i++;
    }
    const data: string[] = [];
    let ended = false;
    for (i++; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("-----END PGP")) {
            ended = true;
            break;
        }
        if (line.startsWith("=")) {
            continue;
        }
        data.push(line);
    }
    const joined = data.join("");
    if (!ended || joined === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(joined)) {
        throw new Unreadable("unreadable armour");
    }
    return Buffer.from(joined, "base64");
}

function readPackets(buf: Buffer): Packet[] {
    const packets: Packet[] = [];
    let at = 0;
    while (at < buf.length) {
        const first = buf[at++];
        if ((first & 0x80) === 0) {
            throw new Unreadable("not a packet");
        }
        let tag: number;
        let length: number;
        if ((first & 0x40) !== 0) {
            tag = first & 0x3f;
            const b = buf[at++];
            if (b == null) {
                throw new Unreadable("truncated");
            }
            if (b < 192) {
                length = b;
            } else if (b < 224) {
                length = ((b - 192) << 8) + buf[at++] + 192;
            } else if (b === 255) {
                length = buf.readUInt32BE(at);
                at += 4;
            } else {
                throw new Unreadable("partial packet lengths are not used by keys or signatures");
            }
        } else {
            tag = (first >> 2) & 0x0f;
            const kind = first & 3;
            if (kind === 0) {
                length = buf[at++];
            } else if (kind === 1) {
                length = buf.readUInt16BE(at);
                at += 2;
            } else if (kind === 2) {
                length = buf.readUInt32BE(at);
                at += 4;
            } else {
                throw new Unreadable("indeterminate packet length");
            }
        }
        if (!(length >= 0) || at + length > buf.length) {
            throw new Unreadable("truncated");
        }
        packets.push({ tag, body: buf.subarray(at, at + length) });
        at += length;
    }
    return packets;
}

type Subpacket = { type: number; data: Buffer };

function readSubpackets(area: Buffer): Subpacket[] {
    const rtn: Subpacket[] = [];
    let at = 0;
    while (at < area.length) {
        let length = area[at++];
        if (length >= 192 && length < 255) {
            length = ((length - 192) << 8) + area[at++] + 192;
        } else if (length === 255) {
            length = area.readUInt32BE(at);
            at += 4;
        }
        if (length < 1 || at + length > area.length) {
            throw new Unreadable("bad subpacket");
        }
        rtn.push({ type: area[at] & 0x7f, data: area.subarray(at + 1, at + length) });
        at += length;
    }
    return rtn;
}

// A multiprecision integer: its length in bits, then the bytes.
function readMpi(buf: Buffer, at: number): { value: Buffer; next: number } {
    if (at + 2 > buf.length) {
        throw new Unreadable("truncated");
    }
    const bytes = Math.ceil(buf.readUInt16BE(at) / 8);
    if (at + 2 + bytes > buf.length) {
        throw new Unreadable("truncated");
    }
    return { value: buf.subarray(at + 2, at + 2 + bytes), next: at + 2 + bytes };
}

function uint32(data: Buffer): number {
    return data.length === 4 ? data.readUInt32BE(0) : null;
}

// The first public key packet of an armoured key file, with its fingerprint (RFC 4880 12.2) and its expiration.
export function readReleaseKey(armored: string): ReleaseKey {
    const packets = readPackets(dearmor(armored));
    const at = packets.findIndex((p) => p.tag === TagPublicKey);
    if (at < 0) {
        throw new Unreadable("no public key");
    }
    const body = packets[at].body;
    if (body.length < 6 || body[0] !== SignatureVersion || body[5] !== AlgorithmEdDsa) {
        throw new Unreadable("the release key must be a version 4 Ed25519 key");
    }
    const oidLength = body[6];
    if (!body.subarray(7, 7 + oidLength).equals(Ed25519Oid)) {
        throw new Unreadable("the release key must be an Ed25519 key");
    }
    const point = readMpi(body, 7 + oidLength);
    if (point.next !== body.length || point.value.length !== 33 || point.value[0] !== 0x40) {
        throw new Unreadable("unexpected Ed25519 point");
    }
    const publicKey = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: point.value.subarray(1).toString("base64url") },
        format: "jwk",
    });
    const length = Buffer.alloc(2);
    length.writeUInt16BE(body.length);
    const fingerprint = createHash("sha1")
        .update(Buffer.from([0x99]))
        .update(length)
        .update(body)
        .digest("hex")
        .toUpperCase();
    // The self-signatures that follow the key (up to the next key packet) say how long it lives.
    let expiresAfter: number = null;
    let newest = -1;
    for (
        let i = at + 1;
        i < packets.length && packets[i].tag !== TagPublicSubkey && packets[i].tag !== TagPublicKey;
        i++
    ) {
        const sig = packets[i];
        if (sig.tag !== TagSignature || sig.body.length < 6 || sig.body[0] !== SignatureVersion) {
            continue;
        }
        if (!CertificationTypes.has(sig.body[1])) {
            continue;
        }
        const hashed = readSubpackets(sig.body.subarray(6, 6 + sig.body.readUInt16BE(4)));
        const created = uint32(hashed.find((s) => s.type === SubpacketCreated)?.data ?? Buffer.alloc(0));
        const lifetime = hashed.find((s) => s.type === SubpacketKeyExpires)?.data;
        if (created != null && created >= newest) {
            newest = created;
            const seconds = lifetime ? uint32(lifetime) : null;
            expiresAfter = seconds == null || seconds === 0 ? null : seconds;
        }
    }
    return {
        fingerprint,
        keyId: fingerprint.slice(-16),
        created: body.readUInt32BE(1),
        expiresAfter,
        publicKey,
    };
}

function failure(reason: SignatureFailure): SignatureResult {
    return { ok: false, reason };
}

// Whether the armoured detached signature is a valid signature of data by key. nowSeconds is the clock (seconds since
// the epoch): a signature made before the key existed or after it expired, or one that has itself expired, is refused.
export function verifyDetachedSignature(
    key: ReleaseKey,
    armoredSignature: string,
    data: Buffer,
    nowSeconds: number
): SignatureResult {
    try {
        const packet = readPackets(dearmor(armoredSignature)).find((p) => p.tag === TagSignature);
        if (packet == null) {
            return failure("unreadable");
        }
        const body = packet.body;
        if (body.length < 10) {
            return failure("unreadable");
        }
        if (
            body[0] !== SignatureVersion ||
            body[1] !== SignatureTypeBinary ||
            body[2] !== AlgorithmEdDsa ||
            HashAlgorithms[body[3]] == null
        ) {
            return failure("unsupported");
        }
        const hashedLength = body.readUInt16BE(4);
        const header = body.subarray(0, 6 + hashedLength);
        const unhashedLength = body.readUInt16BE(6 + hashedLength);
        const after = 8 + hashedLength + unhashedLength;
        const hashed = readSubpackets(body.subarray(6, 6 + hashedLength));
        const unhashed = readSubpackets(body.subarray(8 + hashedLength, after));
        const left = body.subarray(after, after + 2);
        const r = readMpi(body, after + 2);
        const s = readMpi(body, r.next);
        if (left.length !== 2 || s.next !== body.length || r.value.length > 32 || s.value.length > 32) {
            return failure("unreadable");
        }
        const all = [...hashed, ...unhashed];
        const fingerprint = hashed.find((x) => x.type === SubpacketIssuerFingerprint)?.data;
        if (fingerprint != null && fingerprint.subarray(1).toString("hex").toUpperCase() !== key.fingerprint) {
            return failure("wrongkey");
        }
        const keyId = all.find((x) => x.type === SubpacketIssuerKeyId)?.data;
        if (keyId != null && keyId.toString("hex").toUpperCase() !== key.keyId) {
            return failure("wrongkey");
        }
        // A signature that does not say when it was made is not accepted: the key's validity is judged at that time.
        const signedAt = uint32(hashed.find((x) => x.type === SubpacketCreated)?.data ?? Buffer.alloc(0));
        if (signedAt == null) {
            return failure("unsupported");
        }
        if (signedAt < key.created || (key.expiresAfter != null && signedAt > key.created + key.expiresAfter)) {
            return failure("badtime");
        }
        const lifetime = uint32(hashed.find((x) => x.type === SubpacketSignatureExpires)?.data ?? Buffer.alloc(0));
        if (lifetime != null && lifetime > 0 && nowSeconds > signedAt + lifetime) {
            return failure("expired");
        }
        const trailer = Buffer.alloc(6);
        trailer[0] = SignatureVersion;
        trailer[1] = 0xff;
        trailer.writeUInt32BE(header.length, 2);
        const digest = createHash(HashAlgorithms[body[3]]).update(data).update(header).update(trailer).digest();
        if (!digest.subarray(0, 2).equals(left)) {
            return failure("bad");
        }
        const signature = Buffer.concat([
            Buffer.alloc(32 - r.value.length),
            r.value,
            Buffer.alloc(32 - s.value.length),
            s.value,
        ]);
        // EdDSA in OpenPGP signs the hash of the document, not the document.
        return verify(null, digest, key.publicKey, signature) ? { ok: true, signedAt } : failure("bad");
    } catch (e) {
        return failure(e instanceof Unreadable || e instanceof RangeError ? "unreadable" : "bad");
    }
}
