// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"path/filepath"
	"regexp"
	"strings"
)

// The guarded requests (#2257): with boss:autoapprove on, these still ask the developer. Narrow on purpose, so that the
// option keeps its use: what touches MoltenTerm's own data, the developer's credentials and keys, or rewrites a
// remote's history. All of them in this one place.

const (
	GuardOwnData     = "moltenterm-data"
	GuardSsh         = "ssh"
	GuardCredentials = "credentials"
	GuardKeychain    = "keychain"
	GuardRemoteGit   = "remote-git"
)

// The developer's credential files and folders, under the home folder.
var guardedHomePaths = []string{
	".ssh",
	".aws",
	".azure",
	".config/gcloud",
	".config/gh",
	".docker/config.json",
	".git-credentials",
	".gnupg",
	".kube",
	".netrc",
	".npmrc",
	".pypirc",
	"Library/Keychains",
}

// Commands that read or change a keychain or a credential store.
var keychainCommand = regexp.MustCompile(`(^|[\s;&|(])(security\s+(find|add|delete|dump|export|unlock)-|secret-tool\s|gh\s+auth\s+token|git\s+credential\s|keyctl\s)`)

// A push that rewrites or deletes on a remote: --force (with or without lease), -f, a +refspec, --delete, -d, a
// :refspec, --mirror, --prune.
var gitPush = regexp.MustCompile(`(^|[\s;&|(])git(\s+-C\s+\S+)?\s+push\b([^;&|]*)`)
var destructivePushArg = regexp.MustCompile(`(^|\s)(--force(-with-lease|-if-includes)?(=\S*)?|-f|-[a-zA-Z]*f[a-zA-Z]*|--delete|-d|--mirror|--prune|\+\S+|:\S+)(\s|$)`)

// PermitGuardEnv is where the guarded places are on this computer.
type PermitGuardEnv struct {
	Home string
	// DataDirs: MoltenTerm's own data and configuration folders.
	DataDirs []string
	// OwnFolder: his own folder, inside the data folder: his to work in, his brief files aside.
	OwnFolder string
}

// GuardReason names why the request still asks with boss:autoapprove on, "" when it may go.
func GuardReason(ask PermissionAsk, env PermitGuardEnv) string {
	text := ask.Subject
	if ask.Kind == PermitKindCommand {
		if keychainCommand.MatchString(text) {
			return GuardKeychain
		}
		if m := gitPush.FindStringSubmatch(text); m != nil && destructivePushArg.MatchString(m[3]) {
			return GuardRemoteGit
		}
	}
	if ask.Kind == PermitKindFetch || ask.Kind == PermitKindSearch {
		return ""
	}
	// His brief, however it is named (he works in his own folder, so a bare name is his): only the developer changes it.
	if ask.Kind != PermitKindRead {
		for _, name := range briefFiles {
			if strings.Contains(text, name) {
				return GuardOwnData
			}
		}
	}
	return guardedPath(text, env, ask.Kind == PermitKindRead)
}

// guardedPath finds a guarded place named in a path or a command: as written, with ~, or with $HOME.
func guardedPath(text string, env PermitGuardEnv, read bool) string {
	norm := strings.ReplaceAll(text, "$HOME", "~")
	norm = strings.ReplaceAll(norm, "${HOME}", "~")
	if env.Home != "" {
		norm = strings.ReplaceAll(norm, filepath.Clean(env.Home), "~")
	}
	tilde := func(p string) string {
		p = filepath.Clean(p)
		if env.Home != "" {
			p = strings.Replace(p, filepath.Clean(env.Home), "~", 1)
		}
		return p
	}
	// His own folder is his to work in, but his brief tells him what to do: changing it always asks.
	inData := norm
	if env.OwnFolder != "" {
		own := tilde(env.OwnFolder)
		for _, name := range briefFiles {
			if !read && strings.Contains(norm, own+"/"+name) {
				return GuardOwnData
			}
		}
		inData = strings.ReplaceAll(inData, own+"/", "\x00own/")
		inData = strings.ReplaceAll(inData, own+" ", "\x00own ")
		if strings.HasSuffix(inData, own) {
			inData = strings.TrimSuffix(inData, own) + "\x00own"
		}
	}
	for _, dir := range env.DataDirs {
		if dir != "" && strings.Contains(inData, tilde(dir)) {
			return GuardOwnData
		}
	}
	for _, p := range guardedHomePaths {
		if !strings.Contains(norm, "~/"+p) {
			continue
		}
		if p == ".ssh" {
			return GuardSsh
		}
		if p == "Library/Keychains" {
			return GuardKeychain
		}
		return GuardCredentials
	}
	return ""
}
