#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0
#
# Signs a MoltenTerm release folder with the DiamondForge release key (#576): SHA256SUMS.txt (written by
# moltenterm-release-files.sh) into SHA256SUMS.txt.asc, which covers every file, plus a detached <file>.asc beside each
# AppImage and deb for whoever checks one package alone. Run by .github/workflows/release.yml on a release and on a
# rehearsal, after the checksums.
#
# The switch is the public key committed at release-signing-key.asc together with the secrets, as for Notulia (#1110):
#   - no public key and no secret   nothing is signed, the log says so, the run goes on unsigned;
#   - one without the other         the run fails: a release that silently stopped being signed, or one signed by a key
#                                   nobody published;
#   - a secret that is not the committed key, a wrong passphrase, a signature that does not verify against the
#     committed key alone: the run fails before anything is published.
#
# The key is created by the developer (RELEASE.md, "The release key"), never by an agent or the CI.
#
# usage: scripts/moltenterm-release-sign.sh <folder>
# environment:
#   RELEASE_GPG_PRIVATE_KEY          the ASCII-armoured private key (secret)
#   RELEASE_GPG_PASSPHRASE           its passphrase (secret)
#   MOLTENTERM_RELEASE_PUBLIC_KEY    the public key, default release-signing-key.asc at the repository root
#   GITHUB_OUTPUT                    receives signed=true|false and fingerprint=<fingerprint> when set
set -euo pipefail

dir="${1:?usage: moltenterm-release-sign.sh <folder>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
public_key="${MOLTENTERM_RELEASE_PUBLIC_KEY:-$root/release-signing-key.asc}"
output="${GITHUB_OUTPUT:-/dev/null}"
export MOLTENTERM_RELEASE_PUBLIC_KEY="$public_key"
node "$root/scripts/release-policy.mjs" checksum-inputs

if [ ! -f "$public_key" ] && [ -z "${RELEASE_GPG_PRIVATE_KEY:-}" ]; then
    echo "::notice::No release key committed (release-signing-key.asc) and no RELEASE_GPG_PRIVATE_KEY secret: this release is published unsigned, without SHA256SUMS.txt.asc (RELEASE.md, \"The release key\")."
    echo "signed=false" >> "$output"
    exit 0
fi
if [ ! -f "$public_key" ]; then
    echo "::error::RELEASE_GPG_PRIVATE_KEY is set but no public key is committed at release-signing-key.asc: nobody could verify the signatures. Commit the public key (RELEASE.md, \"The release key\")."
    exit 1
fi
if [ -z "${RELEASE_GPG_PRIVATE_KEY:-}" ]; then
    echo "::error::A release key is committed but the RELEASE_GPG_PRIVATE_KEY secret is missing: this release would silently stop being signed."
    exit 1
fi
if [ -z "${RELEASE_GPG_PASSPHRASE:-}" ]; then
    echo "::error::RELEASE_GPG_PRIVATE_KEY is set but RELEASE_GPG_PASSPHRASE is not."
    exit 1
fi
if [ ! -s "$dir/SHA256SUMS.txt" ]; then
    echo "::error::$dir/SHA256SUMS.txt is missing: run scripts/moltenterm-release-files.sh first."
    exit 1
fi

# A short path: gpg-agent's socket lives in GNUPGHOME, and a socket path has a length limit (about 100 bytes on macOS).
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/mt-gpg.XXXXXX")"
export GNUPGHOME="$work/home"
mkdir -m 700 "$GNUPGHOME"
cleanup() {
    gpgconf --kill all > /dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

# The fingerprints of the primary keys in a key file, without importing it anywhere.
fingerprints() {
    gpg --batch --with-colons --import-options show-only --import "$1" 2> /dev/null |
        awk -F: '$1 == "pub" || $1 == "sec" { primary = 1; next } $1 == "fpr" && primary { print $10; primary = 0 }'
}

expected="$(fingerprints "$public_key")"
if [ -z "$expected" ] || [ "$(printf '%s\n' "$expected" | wc -l)" -ne 1 ]; then
    echo "::error::release-signing-key.asc must hold exactly one OpenPGP public key."
    exit 1
fi

printf '%s\n' "$RELEASE_GPG_PRIVATE_KEY" > "$work/secret.asc"
got="$(fingerprints "$work/secret.asc")"
if [ "$got" != "$expected" ]; then
    echo "::error::RELEASE_GPG_PRIVATE_KEY (${got:-not a readable key}) is not the committed release key ($expected)."
    exit 1
fi
gpg --batch --quiet --import "$work/secret.asc" 2> /dev/null
rm -f "$work/secret.asc"

# A keyring holding the committed public key and nothing else: what someone who imported it has.
gpg --batch --quiet --dearmor --output "$work/public.gpg" "$public_key"

files=("$dir/SHA256SUMS.txt")
for file in "$dir"/*.AppImage "$dir"/*.deb; do
    if [ -e "$file" ]; then
        files+=("$file")
    fi
done

for file in "${files[@]}"; do
    name="$(basename "$file")"
    if ! printf '%s' "$RELEASE_GPG_PASSPHRASE" |
        gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --local-user "$expected" \
            --detach-sign --armor --output "$file.asc" "$file"; then
        rm -f "$file.asc"
        echo "::error::Could not sign $name with the release key: most likely a wrong RELEASE_GPG_PASSPHRASE, or an expired key."
        exit 1
    fi
    if ! gpgv --keyring "$work/public.gpg" "$file.asc" "$file" 2> /dev/null; then
        rm -f "$file.asc"
        echo "::error::The signature of $name does not verify against the committed release key."
        exit 1
    fi
    echo "signed: $name.asc ($expected)"
done

{
    echo "signed=true"
    echo "fingerprint=$expected"
} >> "$output"
