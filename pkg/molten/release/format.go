// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The files the release chain writes (the notes, the engineering record, the changelogs, the version files) go through
// the project's formatter before they are committed (#1095): a project whose CI checks the formatting (SaaSFoundryAI's
// required gate runs `npm run format:check`) would otherwise get a red release commit, and merge-pr would wait on it
// forever. The formatter is found by adapters: the command the pipeline declares (versions.format), else prettier when
// the project has it. Each run says how it went on a FormatMarker line, which the release panel reads.

const (
	FormatMarker = "▶ format: "

	FormatFormatted = "formatted"
	FormatNone      = "none"
	FormatFailed    = "failed"

	FormatterDeclared = "versions.format"
	FormatterPrettier = "prettier"
)

var prettierConfigs = []string{
	".prettierrc", ".prettierrc.json", ".prettierrc.json5", ".prettierrc.yaml", ".prettierrc.yml", ".prettierrc.toml",
	".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts", ".prettierrc.cts", ".prettierrc.mts",
	"prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts", "prettier.config.cts",
	"prettier.config.mts",
}

// A formatter found for the project: its name and the command the files are appended to.
type formatter struct {
	Name    string
	Command string
	// The project's dependencies hold it: they are installed in the release worktree first when missing.
	NeedsDependencies bool
}

type formatterAdapter func(wt string, p *Project) *formatter

// The adapters, the first that answers wins; another formatter is one more adapter.
var formatterAdapters = []formatterAdapter{declaredFormatter, prettierFormatter}

func declaredFormatter(wt string, p *Project) *formatter {
	if strings.TrimSpace(p.Format) == "" {
		return nil
	}
	return &formatter{Name: FormatterDeclared, Command: strings.TrimSpace(p.Format)}
}

// usesPrettier: a prettier configuration file, or package.json naming prettier (its "prettier" key or a dependency).
func usesPrettier(wt string) bool {
	for _, name := range prettierConfigs {
		if _, err := os.Stat(filepath.Join(wt, name)); err == nil {
			return true
		}
	}
	data, err := os.ReadFile(filepath.Join(wt, "package.json"))
	if err != nil {
		return false
	}
	var pkg map[string]json.RawMessage
	if json.Unmarshal(data, &pkg) != nil {
		return false
	}
	if _, ok := pkg["prettier"]; ok {
		return true
	}
	for _, key := range []string{"devDependencies", "dependencies"} {
		var deps map[string]any
		if json.Unmarshal(pkg[key], &deps) == nil && deps["prettier"] != nil {
			return true
		}
	}
	return false
}

func prettierFormatter(wt string, p *Project) *formatter {
	if !usesPrettier(wt) {
		return nil
	}
	// The project's own prettier, never one from the PATH: its version is the one the CI checks with.
	return &formatter{Name: FormatterPrettier, Command: "node_modules/.bin/prettier --write --ignore-unknown", NeedsDependencies: true}
}

func formatterOf(wt string, p *Project) *formatter {
	for _, adapter := range formatterAdapters {
		if f := adapter(wt, p); f != nil {
			return f
		}
	}
	return nil
}

func quoteArg(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// releaseFilesToFormat are the release's files the prepared tree changed, sorted.
func (e *Env) releaseFilesToFormat(ctx context.Context, p *Project, wt string, tag string) []string {
	allowed := p.releaseFiles(tag)
	changed, err := e.changedPaths(ctx, wt)
	if err != nil {
		return nil
	}
	var files []string
	for _, path := range changed {
		if allowed[path] && isRegularFile(filepath.Join(wt, path)) {
			files = append(files, path)
		}
	}
	sort.Strings(files)
	return files
}

func isRegularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// formatRelease runs the project's formatter on the release's changed files in the release worktree. It never refuses
// the release: a missing or failing formatter is said, with the command to run, on a FormatMarker line.
func (e *Env) formatRelease(ctx context.Context, p *Project, wt string, tag string) {
	files := e.releaseFilesToFormat(ctx, p, wt, tag)
	if len(files) == 0 {
		return
	}
	f := formatterOf(wt, p)
	if f == nil {
		e.printf("No formatter found for the files the release wrote (%s): they are committed as written. If the project's CI checks the formatting, declare its formatter in versions.format.\n", strings.Join(files, ", "))
		e.printf("%s%s\n", FormatMarker, FormatNone)
		return
	}
	quoted := make([]string, len(files))
	for i, path := range files {
		quoted[i] = quoteArg(path)
	}
	command := f.Command + " -- " + strings.Join(quoted, " ")
	if f.Name == FormatterDeclared {
		command = f.Command + " " + strings.Join(quoted, " ")
	}
	if f.NeedsDependencies {
		if err := e.installDependencies(ctx, p, wt); err != nil {
			e.printf("The files the release wrote are not formatted the way the project's CI checks: %v. Run in %s: %s\n", err, wt, command)
			e.printf("%s%s %s\n", FormatMarker, FormatFailed, command)
			return
		}
	}
	if _, err := e.run(ctx, wt, "sh", "-c", command); err != nil {
		e.printf("The files the release wrote are not formatted the way the project's CI checks: %s failed (%v). Run in %s: %s\n", f.Name, err, wt, command)
		e.printf("%s%s %s\n", FormatMarker, FormatFailed, command)
		return
	}
	e.printf("Formatted with %s: %s.\n", f.Name, strings.Join(files, ", "))
	e.printf("%s%s %s\n", FormatMarker, FormatFormatted, f.Name)
}
