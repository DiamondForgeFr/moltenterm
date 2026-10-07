// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// FindRealBinary walks PATH for the agent's real program, skipping the launchers' folder and any launcher, this
// MoltenTerm's or another build's (isLauncher): the launcher must never exec itself. Relative and empty entries are
// skipped too, so the current folder never supplies the agent.
func FindRealBinary(name string, pathEnv string, launcherDir string, isLauncher func(path string) bool) (string, bool) {
	skip := ""
	if launcherDir != "" {
		skip = filepath.Clean(launcherDir)
	}
	home, _ := os.UserHomeDir()
	for _, dir := range filepath.SplitList(pathEnv) {
		// Shells expand a leading ~ of a PATH entry when they look a command up.
		if rest, ok := strings.CutPrefix(dir, "~"); ok && home != "" && (rest == "" || rest[0] == '/' || rest[0] == filepath.Separator) {
			dir = home + rest
		}
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		if skip != "" && filepath.Clean(dir) == skip {
			continue
		}
		for _, candidate := range programCandidates(dir, name) {
			if !isExecutableFile(candidate) {
				continue
			}
			if isLauncher != nil && isLauncher(candidate) {
				continue
			}
			return candidate, true
		}
	}
	return "", false
}

func programCandidates(dir string, name string) []string {
	if runtime.GOOS != "windows" {
		return []string{filepath.Join(dir, name)}
	}
	exts := strings.Split(strings.ToLower(os.Getenv("PATHEXT")), ";")
	if len(exts) == 0 || exts[0] == "" {
		exts = []string{".com", ".exe", ".bat", ".cmd"}
	}
	var rtn []string
	for _, ext := range exts {
		if ext != "" {
			rtn = append(rtn, filepath.Join(dir, name+ext))
		}
	}
	return rtn
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0111 != 0
}

// IsLauncher tells whether a program is a MoltenTerm launcher: wsh under another name (a link to it, or a copy in a
// launchers' folder next to a wsh on Windows).
func IsLauncher(path string) bool {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	if isWshName(filepath.Base(resolved)) {
		return true
	}
	dir := filepath.Dir(resolved)
	if filepath.Base(dir) != AgentBinDirName {
		return false
	}
	for _, wsh := range []string{"wsh", "wsh.exe"} {
		if _, err := os.Stat(filepath.Join(filepath.Dir(dir), wsh)); err == nil {
			return true
		}
	}
	return false
}

// wsh is installed as wsh, and shipped in the app as wsh-<version>-<os>-<arch>.
func isWshName(base string) bool {
	base = strings.TrimSuffix(strings.ToLower(base), ".exe")
	return base == "wsh" || strings.HasPrefix(base, "wsh-")
}
