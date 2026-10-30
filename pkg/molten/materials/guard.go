// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity/checkpoint"
)

// The guard before a copy (DS-MAT-004): the forbidden paths, checked on the resolved real path before any read; the
// secret detection of the task checkpoint (checkpoint/redact.go), which only detects; and the cleaning of addresses.

// Folders under the home folder whose files are never copied nor listed as a copy: keys and credentials, the agents'
// configuration.
var forbiddenHomeDirs = []string{
	".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".config/op", ".azure", ".kube", ".docker",
	".password-store", ".claude", ".codex", ".gemini", ".config/claude", ".local/share/keyrings",
	"Library/Keychains", "Library/Application Support/Claude",
}

// Files whose name says a key or credentials, whatever their folder.
var forbiddenNames = []string{".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials", "known_hosts", "authorized_keys"}

var forbiddenExts = map[string]bool{".pem": true, ".key": true, ".p12": true, ".pfx": true, ".keychain": true, ".kdbx": true, ".asc": true, ".gpg": true}

// Query parameters an address loses (lower case, matched as a part of the name).
var sensitiveParams = []string{"token", "signature", "sig", "key", "secret", "password", "passwd", "auth", "credential", "session", "code", "ticket", "jwt", "otp"}

// Parameters that make an address a signed one that expires: such an address is not kept at all.
var signedParams = []string{"x-amz-signature", "x-amz-credential", "x-goog-signature", "x-goog-credential", "googleaccessid", "se", "sv", "expires", "x-amz-expires", "policy", "key-pair-id"}

// guard holds the folders the forbidden list depends on.
type guard struct {
	home string
	// own: MoltenTerm's data and configuration folders (briefs, checkpoints, the materials themselves).
	own  []string
	temp []string
}

func makeGuard(home string, own []string) guard {
	g := guard{home: home}
	for _, dir := range own {
		if dir != "" {
			g.own = append(g.own, realOrClean(dir))
		}
	}
	temps := []string{"/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", os.TempDir()}
	if runtime.GOOS == "windows" {
		temps = []string{os.TempDir()}
	}
	seen := map[string]bool{}
	for _, t := range temps {
		if t == "" {
			continue
		}
		for _, d := range []string{filepath.Clean(t), realOrClean(t)} {
			if !seen[d] {
				seen[d] = true
				g.temp = append(g.temp, d)
			}
		}
	}
	return g
}

func realOrClean(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

// within tells whether path is dir or inside it.
func within(path string, dir string) bool {
	if dir == "" {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// forbidden tells why a real path (symbolic links resolved) is never copied, "" when it may be.
func (g guard) forbidden(real string) string {
	base := filepath.Base(real)
	lower := strings.ToLower(base)
	if forbiddenExts[strings.ToLower(filepath.Ext(base))] || strings.HasPrefix(lower, "id_") || strings.HasPrefix(lower, ".env") {
		return "a key or credentials file"
	}
	for _, name := range forbiddenNames {
		if lower == name {
			return "a key or credentials file"
		}
	}
	if g.home != "" {
		home := realOrClean(g.home)
		for _, dir := range forbiddenHomeDirs {
			if within(real, filepath.Join(home, filepath.FromSlash(dir))) {
				return "under a keys, credentials or agent configuration folder"
			}
		}
	}
	for _, dir := range g.own {
		if within(real, dir) {
			return "MoltenTerm's own data"
		}
	}
	return ""
}

// mayBeLost: under a temporary folder of the system, or under an agent worktree.
func (g guard) mayBeLost(path string) bool {
	for _, t := range g.temp {
		if within(path, t) {
			return true
		}
	}
	slashed := filepath.ToSlash(path)
	return strings.Contains(slashed, "/.claude/worktrees/") || strings.Contains(slashed, "/.codex/worktrees/") || strings.Contains(slashed, "/.worktrees/")
}

// resolveFile resolves a path to a regular file that may be read: absolute, existing, symbolic links followed, not
// forbidden. It returns the real path.
func (g guard) resolveFile(path string) (string, os.FileInfo, error) {
	if path == "" || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || len(path) > 4096 {
		return "", nil, fmt.Errorf("not an absolute path")
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", nil, fmt.Errorf("no such file")
	}
	if why := g.forbidden(real); why != "" {
		return "", nil, fmt.Errorf("never kept: %s", why)
	}
	// The path as given may name a forbidden folder through a link.
	if why := g.forbidden(filepath.Clean(path)); why != "" {
		return "", nil, fmt.Errorf("never kept: %s", why)
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", nil, fmt.Errorf("no such file")
	}
	if !info.Mode().IsRegular() {
		return "", nil, fmt.Errorf("not a regular file")
	}
	return real, info, nil
}

// hasSecret runs the checkpoint's detection on a text; the text is not changed.
func hasSecret(text string) bool {
	_, n := checkpoint.Redact(text)
	return n > 0
}

// CleanAddress drops an address's sensitive parameters, its user name and password; ok is false for an address that
// is not http(s) or that is signed and expires (never kept).
func CleanAddress(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", false
	}
	u.User = nil
	q := u.Query()
	for name := range q {
		lower := strings.ToLower(name)
		for _, signed := range signedParams {
			if lower == signed {
				return "", false
			}
		}
	}
	for name := range q {
		lower := strings.ToLower(name)
		for _, word := range sensitiveParams {
			if strings.Contains(lower, word) {
				q.Del(name)
				break
			}
		}
	}
	u.RawQuery = q.Encode()
	if hasSecret(u.String()) {
		return "", false
	}
	return u.String(), true
}
