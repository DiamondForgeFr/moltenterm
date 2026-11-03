// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package metaguard

import (
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// What a server may be allowed to read or write on this computer is bounded by folder: "always" covers the folder of
// the path the developer approved and its subfolders, never a wider one, and never the locations a server could use
// to run code or steal credentials, which are asked every time (#1831).

// sensitiveHomePaths are relative to the home folder: credentials, shell startup files and autostart folders.
var sensitiveHomePaths = []string{
	".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".config/hub",
	".netrc", ".git-credentials", ".gitconfig", ".npmrc", ".pypirc", ".password-store", ".local/share/keyrings",
	"Library/Keychains", "Library/LaunchAgents", "Library/Application Support/com.apple.backgroundtaskmanagementagent",
	".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin",
	".zlogout", ".config/fish", ".config/nushell", ".config/powershell", ".config/autostart", ".config/systemd",
	".config/environment.d", ".xprofile", ".xinitrc", ".xsession", ".pam_environment",
	"AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup", "AppData/Roaming/Microsoft/Credentials",
	"Documents/WindowsPowerShell", "Documents/PowerShell",
}

// sensitiveSystemPaths are absolute: system startup locations and configuration.
var sensitiveSystemPaths = []string{
	"/etc", "/Library/LaunchAgents", "/Library/LaunchDaemons", "/Library/StartupItems", "/System",
	"/usr/lib/systemd", "/lib/systemd", "C:/ProgramData/Microsoft/Windows/Start Menu/Programs/StartUp",
	"C:/Windows",
}

// CleanLocalPath is path on this computer as the question shows it and the grants compare it: home expanded, made
// absolute and clean, its links resolved where they exist.
func CleanLocalPath(path string) string {
	expanded := wavebase.ExpandHomeDirSafe(strings.TrimSpace(path))
	if !filepath.IsAbs(expanded) {
		expanded = filepath.Join(wavebase.GetHomeDir(), expanded)
	}
	return resolveExisting(filepath.Clean(expanded))
}

// resolveExisting resolves the links of the longest existing part of path; the rest stays as written.
func resolveExisting(path string) string {
	rest := ""
	for dir := path; ; dir = filepath.Dir(dir) {
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(real, rest)
		}
		if filepath.Dir(dir) == dir {
			return path
		}
		rest = filepath.Join(filepath.Base(dir), rest)
	}
}

// ShownPath is a path as the window's question prints it: control and format characters (a newline, a right-to-left
// override) are replaced so the developer reads the path that will be used.
func ShownPath(path string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return '?'
		}
		return r
	}, path)
}

// PathWithin tells whether path is dir or inside it, case ignored where the disk ignores it.
func PathWithin(path string, dir string) bool {
	if samePath(path, dir) {
		return true
	}
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	if caseInsensitiveDisk {
		rel, err = filepath.Rel(strings.ToLower(dir), strings.ToLower(path))
		if err != nil {
			return false
		}
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// IsSensitiveLocalPath tells whether a cleaned path is, or is inside, a location a server could use to run code or
// read credentials (startup and autostart folders, shell startup files, keys and keychains, cloud CLIs), or
// MoltenTerm's own data and configuration. The window asks for it every time, with no "always".
func IsSensitiveLocalPath(path string) bool {
	home := wavebase.GetHomeDir()
	for _, rel := range sensitiveHomePaths {
		if PathWithin(path, resolveExisting(filepath.Join(home, filepath.FromSlash(rel)))) {
			return true
		}
	}
	for _, abs := range sensitiveSystemPaths {
		if PathWithin(path, resolveExisting(filepath.FromSlash(abs))) {
			return true
		}
	}
	for _, dir := range []string{wavebase.GetWaveDataDir(), wavebase.GetWaveConfigDir()} {
		if dir != "" && PathWithin(path, resolveExisting(dir)) {
			return true
		}
	}
	return false
}

// AlwaysFolder is the folder an "always" answer for path covers: the folder holding path. None (false) when that
// folder is the root, the home folder or above it, or a sensitive location: those are asked every time.
func AlwaysFolder(path string) (string, bool) {
	dir := path
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		dir = filepath.Dir(path)
	}
	if filepath.Dir(dir) == dir || tooWideProjectFolder(dir) || IsSensitiveLocalPath(dir) || IsSensitiveLocalPath(path) {
		return "", false
	}
	return dir, true
}
