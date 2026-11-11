// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"os"
	"path/filepath"
	"strings"
)

// What boss:autoapprove may let through (#2257, second review): an allowlist, never a list of what to refuse. A text
// check of what to refuse was easy to get around (sh -c, an absolute /usr/bin/security, "$HOME", ~/./.ssh, a glob, a
// ../ out of his folder, a symlink...). So a request is approved without asking only when it is plainly harmless, and
// everything else asks the developer:
//   - reading, editing, writing or patching files only under his own folder, by their real path (symlinks resolved),
//     never a hidden file or folder there (.claude, .codex, .git: an agent's settings would widen what it may do), nor
//     his brief;
//   - a command only when it is one simple command, run in his own folder, whose first word is on a short list of
//     read-only tools, git status|diff|log|show, or a test runner; no shell syntax at all (no $, no quotes, no
//     backslash, no ; & | < > ( ) { } [ ] * ? ~ ! # or newline), no -c, no absolute path, no .., no cd, and every word
//     that names an existing file resolves under his folder;
//   - a web fetch or search always asks: what a page holds or where a query goes cannot be judged from here (the
//     stricter of the two choices the review gave).

const (
	// Why a request still asks with boss:autoapprove on.
	GuardWeb     = "web"
	GuardPath    = "path"
	GuardCommand = "command"
	GuardCwd     = "cwd"
	GuardKind    = "kind"
)

// The first words a command may start with. Each reads, or runs the tests of, what is in his folder.
var safeCommands = map[string]bool{
	"ls": true, "cat": true, "head": true, "tail": true, "wc": true, "grep": true, "rg": true, "pwd": true,
	"echo": true, "date": true, "diff": true, "stat": true, "file": true, "tree": true, "sort": true, "uniq": true,
}

// git, only to look.
var safeGitCommands = map[string]bool{"status": true, "diff": true, "log": true, "show": true}

// Test runners, as "<tool> <subcommand>".
var safeTestCommands = map[string]bool{
	"go test": true, "npm test": true, "pnpm test": true, "yarn test": true, "cargo test": true, "pytest": true,
	"npx vitest": true,
}

// Any of these makes a command shell syntax, not one simple command.
const shellSyntax = "$`'\"\\;&|<>(){}[]*?~!#\n\r\t"

// PermitGuardEnv is where his folder is on this computer.
type PermitGuardEnv struct {
	// OwnFolder: his own folder, the one place he may work in without asking.
	OwnFolder string
}

// GuardReason names why the request still asks with boss:autoapprove on, "" when it may go without asking.
func GuardReason(ask PermissionAsk, env PermitGuardEnv) string {
	own := realPath(env.OwnFolder)
	if own == "" {
		return GuardPath
	}
	switch ask.Kind {
	case PermitKindFetch, PermitKindSearch:
		return GuardWeb
	case PermitKindRead, PermitKindEdit, PermitKindWrite:
		if !pathAllowed(ask.Subject, ask.Cwd, own) {
			return GuardPath
		}
		return ""
	case PermitKindPatch:
		for _, line := range strings.Split(ask.Subject, "\n") {
			_, path, ok := strings.Cut(line, " ")
			if !ok || !pathAllowed(path, ask.Cwd, own) {
				return GuardPath
			}
		}
		return ""
	case PermitKindCommand:
		if cwd := realPath(ask.Cwd); cwd == "" || !within(cwd, own) {
			return GuardCwd
		}
		if !commandAllowed(ask.Subject, ask.Cwd, own) {
			return GuardCommand
		}
		return ""
	}
	return GuardKind
}

func commandAllowed(command string, cwd string, own string) bool {
	if strings.ContainsAny(command, shellSyntax) {
		return false
	}
	words := strings.Fields(command)
	if len(words) == 0 {
		return false
	}
	first := words[0]
	switch {
	case safeCommands[first]:
	case first == "git":
		if len(words) < 2 || !safeGitCommands[words[1]] {
			return false
		}
	case first == "pytest" || (len(words) >= 2 && safeTestCommands[first+" "+words[1]]):
	default:
		return false
	}
	for _, w := range words[1:] {
		if w == "-c" || strings.HasPrefix(w, "/") || strings.Contains(w, "..") || w == "cd" {
			return false
		}
		// A git option that points it elsewhere, or a test flag that writes a file.
		if strings.HasPrefix(w, "--git-dir") || strings.HasPrefix(w, "--work-tree") || strings.HasPrefix(w, "--output") ||
			strings.HasPrefix(w, "--exec") || strings.HasPrefix(w, "-C") || strings.HasPrefix(w, "-o") {
			return false
		}
		// A word that names an existing file must be his: a symlink in his folder does not lead out of it.
		if strings.HasPrefix(w, "-") {
			continue
		}
		candidate := filepath.Join(cwd, w)
		if _, err := os.Lstat(candidate); err == nil && !pathAllowed(candidate, cwd, own) {
			return false
		}
	}
	return true
}

// pathAllowed: the path, made absolute from cwd and with its symlinks resolved (a file not there yet by its deepest
// existing folder), is under his folder, names no hidden file or folder there, and is not his brief.
func pathAllowed(path string, cwd string, own string) bool {
	if path == "" || strings.ContainsAny(path, "$`*?[]{}~\\\n\r\x00") {
		return false
	}
	if !filepath.IsAbs(path) {
		if cwd == "" {
			return false
		}
		path = filepath.Join(cwd, path)
	}
	real := realPath(filepath.Clean(path))
	if real == "" || !within(real, own) || real == own {
		return false
	}
	rel, err := filepath.Rel(own, real)
	if err != nil {
		return false
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	for _, name := range briefFiles {
		if strings.EqualFold(rel, name) {
			return false
		}
	}
	return true
}

// realPath resolves symlinks; for a path not there yet, its deepest existing folder's, joined with the rest.
func realPath(path string) string {
	if path == "" || !filepath.IsAbs(path) {
		return ""
	}
	path = filepath.Clean(path)
	rest := ""
	for {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			return filepath.Join(resolved, rest)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return ""
		}
		rest = filepath.Join(filepath.Base(path), rest)
		path = parent
	}
}

func within(path string, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
