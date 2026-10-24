// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A project whose git hooks run its own tools (husky, lefthook, simple-git-hooks: a pre-commit running lint-staged
// or tests, a commit-msg running commitlint) refuses the release worktree's commits until that worktree has the
// project's dependencies (#1046). They are installed there once, before the first commit: the project's ci.prepare
// when it declares one, else its package manager's clean install.

var hookTools = []string{"husky", "lefthook", "simple-git-hooks", "pre-commit", "@commitlint/cli", "lint-staged"}

// usesHookTools tells whether the project's git hooks need its node dependencies.
func usesHookTools(wt string) bool {
	for _, dir := range []string{".husky", ".lefthook"} {
		if info, err := os.Stat(filepath.Join(wt, dir)); err == nil && info.IsDir() {
			return true
		}
	}
	if _, err := os.Stat(filepath.Join(wt, "lefthook.yml")); err == nil {
		return true
	}
	data, err := os.ReadFile(filepath.Join(wt, "package.json"))
	if err != nil {
		return false
	}
	for _, tool := range hookTools {
		if strings.Contains(string(data), `"`+tool+`"`) {
			return true
		}
	}
	return false
}

// installCommand is the clean install of the project's package manager, read from its lockfile.
func installCommand(wt string) string {
	for _, c := range []struct{ lock, run string }{
		{"pnpm-lock.yaml", "pnpm install --frozen-lockfile"},
		{"yarn.lock", "yarn install --frozen-lockfile"},
		{"bun.lockb", "bun install --frozen-lockfile"},
		{"bun.lock", "bun install --frozen-lockfile"},
		{"package-lock.json", "npm ci"},
	} {
		if _, err := os.Stat(filepath.Join(wt, c.lock)); err == nil {
			return c.run
		}
	}
	return "npm install"
}

// installForHooks installs the dependencies the project's git hooks need in the release worktree, unless they are
// there from an earlier run (the reset keeps ignored files).
func (e *Env) installForHooks(ctx context.Context, p *Project, wt string) error {
	if !usesHookTools(wt) {
		return nil
	}
	if info, err := os.Stat(filepath.Join(wt, "node_modules")); err == nil && info.IsDir() {
		return nil
	}
	run := p.Install
	if run == "" {
		run = installCommand(wt)
	}
	e.printf("The project's git hooks need its dependencies: %s in %s.\n", run, wt)
	if _, err := e.run(ctx, wt, "sh", "-c", run); err != nil {
		return fmt.Errorf("could not install the dependencies the git hooks need (%s): %w", run, err)
	}
	return nil
}
