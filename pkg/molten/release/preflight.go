// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// A tag that a later workflow refuses is already public and its number is burnt: v1.0.0-12 was pushed by finalize, then
// the dependency scan of release.yml refused the Electron pin, and the tag had to be deleted (#2365). The checks the
// project declares in release.preflight run first, in the release worktree, on the tree about to be tagged, so that the
// refusal comes before anything is committed, tagged or pushed. The package knows no project's script: a check is a
// command whose exit code decides, and the fix said with its failure is the project's own. A check that cannot be run
// fails like one that fails: a read that did not happen is never a pass.

const (
	preflightRunning       = "running"
	preflightDetailLines   = 5
	preflightDetailLimit   = 300
	preflightUnnamedReason = "it exited with an error"
	preflightDetailMargin  = "           | "
	preflightErrorMarker   = "::error"
)

// GitHub's workflow annotation (::error title=...::text): scripts written for a workflow print their findings this way.
var annotationRegex = regexp.MustCompile(`^::(?:error|warning|notice)[^:]*::`)

// checkPreflight runs every declared check and reports each on r. A check never stops the ones after it: the report
// lists every failure.
func (e *Env) checkPreflight(ctx context.Context, r *readiness, p *Project, wt string, tag string, v versions.Version) {
	if len(p.Preflight) == 0 {
		return
	}
	e.printf("Running the preflight checks of %s in %s, before anything is tagged.\n", tag, wt)
	vars := strings.NewReplacer("{tag}", tag, "{version}", v.String(), "{branch}", p.Release)
	for _, check := range p.Preflight {
		e.runPreflightCheck(ctx, r, wt, check, vars)
	}
}

func (e *Env) runPreflightCheck(ctx context.Context, r *readiness, wt string, check molten.PipelineCheck, vars *strings.Replacer) {
	name := strings.TrimSpace(check.Title)
	if name == "" {
		name = check.Id
	}
	dir := wt
	if check.Cwd != "" {
		dir = filepath.Join(wt, filepath.FromSlash(check.Cwd))
		if !insideDir(wt, dir) {
			r.problem("preflight check %q cannot run: its cwd %q leaves the project", name, check.Cwd)
			return
		}
	}
	command := vars.Replace(check.Run)
	r.say(preflightRunning, "%s: %s", name, command)
	out, err := e.run(ctx, dir, "sh", "-c", command)
	if err == nil {
		r.ok("%s passed", name)
		return
	}
	for _, line := range preflightFindings(string(out)) {
		e.printf("%s%s\n", preflightDetailMargin, line)
	}
	text := fmt.Sprintf("preflight check %q failed: %s", name, preflightReason(err, command))
	if fix := strings.TrimSpace(check.Fix); fix != "" {
		text += ". To fix: " + fix
	}
	r.problem("%s", text)
}

// preflightReason is the line the failed command ended with, as ExecRunner reports it (its last error line), without
// the command that every error starts with.
func preflightReason(err error, command string) string {
	reason := strings.TrimPrefix(err.Error(), "sh -c "+command+": ")
	reason = strings.TrimRight(strings.TrimSpace(annotationRegex.ReplaceAllString(reason, "")), ". ")
	if reason == "" {
		return preflightUnnamedReason
	}
	return reason
}

// preflightFindings are the lines shown under a failed check: the findings it printed as ::error annotations, else its
// last lines. A check's own report is not shown whole: what it advises is the project's to say, in release.preflight's fix.
func preflightFindings(out string) []string {
	var annotated, lines []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, preflightErrorMarker) {
			annotated = append(annotated, shortenLine(annotationRegex.ReplaceAllString(line, "")))
		}
		lines = append(lines, shortenLine(line))
	}
	if len(annotated) > 0 {
		return annotated
	}
	if len(lines) > preflightDetailLines {
		lines = lines[len(lines)-preflightDetailLines:]
	}
	return lines
}

func shortenLine(line string) string {
	line = strings.TrimSpace(line)
	if runes := []rune(line); len(runes) > preflightDetailLimit {
		return string(runes[:preflightDetailLimit]) + "…"
	}
	return line
}

// preflight is the checks on a report of their own, for the commands that tag without finalize's report: nothing is
// printed when the project declares none.
func (e *Env) preflight(ctx context.Context, p *Project, wt string, tag string, v versions.Version) error {
	if len(p.Preflight) == 0 {
		return nil
	}
	ready := e.beginReadiness(tag, "be tagged")
	e.checkPreflight(ctx, ready, p, wt, tag, v)
	return ready.finish(tag, "nothing was tagged")
}
