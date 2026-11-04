// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Fake release keys for the tests of the in-app update (#1860): an Ed25519 key made on the spot, its armoured public
// key, and detached signatures in the packet layout GnuPG writes. The tests never touch the real release key, and
// moltenterm-openpgp.test.ts checks this layout against signatures made by gpg itself.

import { createHash, generateKeyPairSync, KeyObject, sign } from "crypto";

const Ed25519Oid = Buffer.from("2b06010401da470f01", "hex");
const HashIds: Record<string, number> = { sha256: 8, sha384: 9, sha512: 10 };

function packet(tag: number, body: Buffer): Buffer {
    const length = body.length;
    let head: Buffer;
    if (length < 192) {
        head = Buffer.from([0xc0 | tag, length]);
    } else if (length < 8384) {
        head = Buffer.from([0xc0 | tag, ((length - 192) >> 8) + 192, (length - 192) & 0xff]);
    } else {
        head = Buffer.alloc(6);
        head[0] = 0xc0 | tag;
        head[1] = 255;
        head.writeUInt32BE(length, 2);
    }
    return Buffer.concat([head, body]);
}

function subpacket(type: number, data: Buffer): Buffer {
    return Buffer.concat([Buffer.from([data.length + 1, type]), data]);
}

function uint32(value: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value);
    return b;
}

function bitLength(value: Buffer): number {
    let at = 0;
    while (at < value.length && value[at] === 0) {
        at++;
    }
    if (at === value.length) {
        return 0;
    }
    return (value.length - at - 1) * 8 + (32 - Math.clz32(value[at]));
}

// An MPI without its leading zero bytes, as GnuPG writes it.
function mpi(value: Buffer): Buffer {
    let at = 0;
    while (at < value.length && value[at] === 0) {
        at++;
    }
    const bits = Buffer.alloc(2);
    bits.writeUInt16BE(bitLength(value));
    return Buffer.concat([bits, value.subarray(at)]);
}

function armor(kind: string, bytes: Buffer): string {
    const lines = bytes.toString("base64").match(/.{1,64}/g) ?? [];
    return `-----BEGIN PGP ${kind}-----\n\n${lines.join("\n")}\n-----END PGP ${kind}-----\n`;
}

export type FakeKeyOptions = {
    // Seconds since the epoch.
    created?: number;
    // Seconds after creation; none for a key that never expires.
    expiresAfter?: number;
};

export type SignOptions = {
    hash?: "sha256" | "sha384" | "sha512";
    // Seconds since the epoch.
    signedAt?: number;
    expiresAfter?: number;
    // What the signature says made it, when that is not the key.
    issuerFingerprint?: Buffer;
    issuerKeyId?: Buffer;
    noCreated?: boolean;
    type?: number;
    version?: number;
};

export type FakeKey = {
    armoredPublic: string;
    fingerprint: string;
    keyId: string;
    created: number;
    sign: (data: Buffer, options?: SignOptions) => string;
};

export const FakeKeyCreated = 1_700_000_000;
export const FakeSignedAt = 1_800_000_000;

export function makeFakeKey(options: FakeKeyOptions = {}): FakeKey {
    const created = options.created ?? FakeKeyCreated;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const point = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
    const body = Buffer.concat([
        Buffer.from([4]),
        uint32(created),
        Buffer.from([22, Ed25519Oid.length]),
        Ed25519Oid,
        mpi(Buffer.concat([Buffer.from([0x40]), point])),
    ]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(body.length);
    const fingerprintBytes = createHash("sha1")
        .update(Buffer.from([0x99]))
        .update(length)
        .update(body)
        .digest();
    const fingerprint = fingerprintBytes.toString("hex").toUpperCase();
    const keyIdBytes = fingerprintBytes.subarray(12);
    const packets = [packet(6, body), packet(13, Buffer.from("Fake Release <fake@example.invalid>"))];
    if (options.expiresAfter != null) {
        // The key's self-signature only has to carry the subpackets the reader looks at.
        const hashed = Buffer.concat([subpacket(2, uint32(created)), subpacket(9, uint32(options.expiresAfter))]);
        const head = Buffer.concat([
            Buffer.from([4, 0x13, 22, 8]),
            Buffer.from([hashed.length >> 8, hashed.length & 0xff]),
        ]);
        packets.push(
            packet(
                2,
                Buffer.concat([
                    head,
                    hashed,
                    Buffer.from([0, 0, 0, 0]),
                    mpi(Buffer.alloc(32, 1)),
                    mpi(Buffer.alloc(32, 2)),
                ])
            )
        );
    }
    const armoredPublic = armor("PUBLIC KEY BLOCK", Buffer.concat(packets));
    return {
        armoredPublic,
        fingerprint,
        keyId: fingerprint.slice(-16),
        created,
        sign: (data, o = {}) => signDetached(privateKey, { data, fingerprintBytes, keyIdBytes }, o),
    };
}

function signDetached(
    privateKey: KeyObject,
    key: { data: Buffer; fingerprintBytes: Buffer; keyIdBytes: Buffer },
    o: SignOptions
): string {
    const hash = o.hash ?? "sha512";
    const hashedSubpackets = [
        subpacket(33, Buffer.concat([Buffer.from([4]), o.issuerFingerprint ?? key.fingerprintBytes])),
    ];
    if (!o.noCreated) {
        hashedSubpackets.push(subpacket(2, uint32(o.signedAt ?? FakeSignedAt)));
    }
    if (o.expiresAfter != null) {
        hashedSubpackets.push(subpacket(3, uint32(o.expiresAfter)));
    }
    const hashed = Buffer.concat(hashedSubpackets);
    const hashedLength = Buffer.alloc(2);
    hashedLength.writeUInt16BE(hashed.length);
    const header = Buffer.concat([Buffer.from([o.version ?? 4, o.type ?? 0, 22, HashIds[hash]]), hashedLength, hashed]);
    const trailer = Buffer.alloc(6);
    trailer[0] = 4;
    trailer[1] = 0xff;
    trailer.writeUInt32BE(header.length, 2);
    const digest = createHash(hash).update(key.data).update(header).update(trailer).digest();
    const signature = sign(null, digest, privateKey);
    const unhashed = subpacket(16, o.issuerKeyId ?? key.keyIdBytes);
    const unhashedLength = Buffer.alloc(2);
    unhashedLength.writeUInt16BE(unhashed.length);
    const body = Buffer.concat([
        header,
        unhashedLength,
        unhashed,
        digest.subarray(0, 2),
        mpi(signature.subarray(0, 32)),
        mpi(signature.subarray(32)),
    ]);
    return armor("SIGNATURE", packet(2, body));
}
