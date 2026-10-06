// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Where Claude Code keeps its sign-in (DS-SHELL-032), as Claude Code itself names it: on macOS a Keychain generic
// password, else (and as Claude Code's own fallback on macOS) `.credentials.json` in its configuration folder. Read
// only, at call time; MoltenTerm never writes, refreshes or copies it.

const (
	claudeKeychainServiceBase = "Claude Code-credentials"
	claudeKeychainTool        = "/usr/bin/security"
	claudeCredentialsFileName = ".credentials.json"
	claudeDefaultAccount      = "claude-code-user"

	// security(1) exits with this code when the item does not exist.
	keychainItemNotFound = 44

	keychainTimeout     = 3 * time.Second
	maxCredentialsBytes = 64 * 1024
)

var claudeAccountPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

var errNoCredentials = errors.New("no Claude Code credentials")

// claudeCredentialPlace is where Claude Code keeps its sign-in for the configuration folder MoltenTerm sees.
type claudeCredentialPlace struct {
	service string
	account string
	file    string
	home    string
}

// claudeCredentialPlaceOf follows Claude Code: CLAUDE_SECURESTORAGE_CONFIG_DIR, else CLAUDE_CONFIG_DIR, else
// ~/.claude; a folder other than the default gets its own Keychain item, suffixed with a hash of the folder.
func claudeCredentialPlaceOf(getenv func(string) (string, bool), home string, username string) claudeCredentialPlace {
	dir, suffixed := filepath.Join(home, ".claude"), false
	if v, ok := getenv("CLAUDE_SECURESTORAGE_CONFIG_DIR"); ok {
		if v != "" {
			dir, suffixed = v, true
		}
	} else if v, _ := getenv("CLAUDE_CONFIG_DIR"); v != "" {
		dir, suffixed = v, true
	}
	service := claudeKeychainServiceBase
	if suffixed {
		sum := sha256.Sum256([]byte(dir))
		service += "-" + hex.EncodeToString(sum[:])[:8]
	}
	account := username
	if !claudeAccountPattern.MatchString(account) {
		account = claudeDefaultAccount
	}
	return claudeCredentialPlace{service: service, account: account, file: filepath.Join(dir, claudeCredentialsFileName), home: home}
}

func currentClaudeCredentialPlace() claudeCredentialPlace {
	home, _ := os.UserHomeDir()
	username := os.Getenv("USER")
	if username == "" {
		if u, err := user.Current(); err == nil {
			username = u.Username
		}
	}
	return claudeCredentialPlaceOf(os.LookupEnv, home, username)
}

// storeName names the place for the confirmation, with ~ for the home folder.
func (p claudeCredentialPlace) storeName(useKeychain bool) string {
	file := p.file
	if p.home != "" && strings.HasPrefix(file, p.home+string(filepath.Separator)) {
		file = "~" + file[len(p.home):]
	}
	if useKeychain {
		return `the macOS Keychain ("` + p.service + `") or ` + file
	}
	return file
}

// limitedBuffer keeps at most max bytes and remembers it was given more.
type limitedBuffer struct {
	buf  bytes.Buffer
	max  int
	over bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	room := b.max - b.buf.Len()
	if len(p) > room {
		b.over = true
		if room > 0 {
			b.buf.Write(p[:room])
		}
		return len(p), nil
	}
	return b.buf.Write(p)
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// readKeychainCredentials asks security(1), by its absolute path, for the item's data; its stderr is dropped and
// nothing of the call is logged.
func readKeychainCredentials(ctx context.Context, place claudeCredentialPlace) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, keychainTimeout)
	defer cancel()
	out := &limitedBuffer{max: maxCredentialsBytes}
	cmd := exec.CommandContext(ctx, claudeKeychainTool, "find-generic-password", "-a", place.account, "-s", place.service, "-w")
	cmd.Stdin = nil
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	data := out.buf.Bytes()
	if err != nil || out.over {
		zero(data)
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == keychainItemNotFound {
			return nil, errNoCredentials
		}
		return nil, Unavailable(ReasonSignedOut)
	}
	return bytes.TrimSpace(data), nil
}

// readCredentialsFile reads a regular file only, never through a symbolic link, as Claude Code does.
func readCredentialsFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errNoCredentials
	}
	if info.Size() > maxCredentialsBytes {
		return nil, Unavailable(ReasonFormat)
	}
	f, err := openNoBlock(path)
	if err != nil {
		return nil, errNoCredentials
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errNoCredentials
	}
	data, err := io.ReadAll(io.LimitReader(f, maxCredentialsBytes+1))
	if err != nil || len(data) > maxCredentialsBytes {
		zero(data)
		return nil, Unavailable(ReasonFormat)
	}
	return data, nil
}

// parseClaudeCredentials takes the access token and its expiry (Unix ms, 0 when not given) and nothing else: the
// refresh token is never decoded. The caller keeps the token in a local variable for one request.
func parseClaudeCredentials(data []byte) (string, int64, error) {
	var doc struct {
		ClaudeAiOauth *struct {
			AccessToken *string  `json:"accessToken"`
			ExpiresAt   *float64 `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", 0, Unavailable(ReasonSignedOut)
	}
	if doc.ClaudeAiOauth == nil || doc.ClaudeAiOauth.AccessToken == nil || strings.TrimSpace(*doc.ClaudeAiOauth.AccessToken) == "" {
		return "", 0, Unavailable(ReasonSignedOut)
	}
	token := strings.TrimSpace(*doc.ClaudeAiOauth.AccessToken)
	if !validBearer(token) {
		return "", 0, Unavailable(ReasonSignedOut)
	}
	var expiresAt int64
	if doc.ClaudeAiOauth.ExpiresAt != nil && *doc.ClaudeAiOauth.ExpiresAt > 0 {
		expiresAt = int64(*doc.ClaudeAiOauth.ExpiresAt)
	}
	return token, expiresAt, nil
}

// validBearer refuses a token that could break the Authorization header.
func validBearer(token string) bool {
	if len(token) > 4096 {
		return false
	}
	for i := 0; i < len(token); i++ {
		c := token[i]
		if c <= ' ' || c >= 0x7f {
			return false
		}
	}
	return true
}

// readClaudeCredentials reads Claude Code's sign-in where Claude Code keeps it: the Keychain first on macOS, then
// the file.
func readClaudeCredentials(ctx context.Context) (string, int64, error) {
	place := currentClaudeCredentialPlace()
	if runtime.GOOS == "darwin" {
		// A Keychain that has no item, is locked or refuses falls back to the file, as Claude Code does.
		if data, err := readKeychainCredentials(ctx, place); err == nil {
			token, expiresAt, perr := parseClaudeCredentials(data)
			zero(data)
			return token, expiresAt, perr
		}
		if ctx.Err() != nil {
			return "", 0, Unavailable(ReasonOffline)
		}
	}
	return readClaudeCredentialsFile(place.file)
}

func readClaudeCredentialsFile(path string) (string, int64, error) {
	data, err := readCredentialsFile(path)
	if err != nil {
		if errors.Is(err, errNoCredentials) {
			return "", 0, Unavailable(ReasonSignedOut)
		}
		return "", 0, err
	}
	token, expiresAt, perr := parseClaudeCredentials(data)
	zero(data)
	return token, expiresAt, perr
}

func claudeCredentialStore() string {
	return currentClaudeCredentialPlace().storeName(runtime.GOOS == "darwin")
}
