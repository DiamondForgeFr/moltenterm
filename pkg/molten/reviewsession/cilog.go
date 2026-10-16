// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// The failed checks review_context names (#797): each with its run's page and, for the first ones, the excerpt of its
// failed log read through the developer's gh, so the read-only agent explains a red CI without running gh itself.

const (
	// Two excerpts of 3 KB keep review_context under the tools' 64 KB with the other sources at their cuts.
	maxCheckLogs       = 2
	maxExcerptBytes    = 3 * 1024
	maxExcerptLines    = 60
	excerptTailLines   = 40
	excerptBeforeLines = 4
	excerptAfterLines  = 12
)

var (
	ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	// gh run view --log-failed prefixes each line with the job, the step and the time.
	logTimeRe = regexp.MustCompile(`^\x{FEFF}?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?`)
	// The lines a failure is told on: Go's --- FAIL, FAIL and panic, vitest's FAIL, × and assertion errors, tsc's
	// errors, and the error annotations of GitHub Actions.
	failureLineRe = regexp.MustCompile(`--- FAIL|^\s*FAIL\b|^panic:|^\s*[×✗]\s|AssertionError|##\[error\]|^\s*Error:|error TS\d+|^\s*(?:Test Files|Tests)\s+\d+ failed`)
)

type checkInfo struct {
	Name     string `json:"name"`
	Workflow string `json:"workflow,omitempty"`
	Url      string `json:"url,omitempty"`
	// Log: "untrusted.cilogs" when an excerpt of its failed log is there; LogWhy: why there is none.
	Log    string `json:"log,omitempty"`
	LogWhy string `json:"logwhy,omitempty"`
}

type ciLogText struct {
	Check   string `json:"check"`
	Url     string `json:"url,omitempty"`
	Excerpt string `json:"excerpt"`
}

// cleanLogLine drops gh's job, step and time prefix and the colour codes.
func cleanLogLine(line string) string {
	line = strings.TrimRight(line, "\r")
	if parts := strings.SplitN(line, "\t", 3); len(parts) == 3 {
		line = parts[2]
	}
	line = logTimeRe.ReplaceAllString(line, "")
	return ansiRe.ReplaceAllString(line, "")
}

// FailureExcerpt keeps what tells why a failed job failed: the lines around each failure line (a Go `--- FAIL` with
// the messages that follow it, a vitest failing test with its assertion), else the log's tail.
func FailureExcerpt(log string) string {
	var lines []string
	for _, line := range strings.Split(strings.TrimRight(log, "\n"), "\n") {
		lines = append(lines, cleanLogLine(line))
	}
	keep := make([]bool, len(lines))
	found := false
	for i, line := range lines {
		if !failureLineRe.MatchString(line) {
			continue
		}
		found = true
		for j := max(0, i-excerptBeforeLines); j <= min(len(lines)-1, i+excerptAfterLines); j++ {
			keep[j] = true
		}
	}
	if !found {
		from := max(0, len(lines)-excerptTailLines)
		return cutExcerpt(lines[from:], from > 0)
	}
	var out []string
	gap := false
	for i, line := range lines {
		if !keep[i] {
			gap = true
			continue
		}
		if gap && len(out) > 0 {
			out = append(out, "…")
		}
		gap = false
		out = append(out, line)
	}
	return cutExcerpt(out, false)
}

func cutExcerpt(lines []string, cutBefore bool) string {
	var b strings.Builder
	if cutBefore {
		b.WriteString("…\n")
	}
	for i, line := range lines {
		if i >= maxExcerptLines || b.Len()+len(line)+1 > maxExcerptBytes {
			b.WriteString("[cut]\n")
			break
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// failedChecks lists the PR's failed checks and reads the failed log of the first ones.
func (m *Manager) failedChecks(ctx context.Context, rec record, ci mission.ReviewCi) ([]checkInfo, []ciLogText) {
	var checks []checkInfo
	var logs []ciLogText
	for _, check := range ci.Checks {
		if check.State != mission.ReviewCheckFailure {
			continue
		}
		info := checkInfo{Name: check.Name, Workflow: check.Workflow, Url: check.Url}
		switch {
		case check.JobId <= 0:
			info.LogWhy = "not a GitHub Actions job: open its page"
		case len(logs) >= maxCheckLogs:
			info.LogWhy = "only the first " + strconv.Itoa(maxCheckLogs) + " failed checks' logs are read"
		default:
			out, err := m.env.Gh(ctx, rec.ProjectDir, "run", "view", "--job", strconv.FormatInt(check.JobId, 10), "--log-failed", "-R", rec.Repo)
			text := strings.TrimSpace(string(out))
			switch {
			case err != nil:
				info.LogWhy = "its log could not be read: " + ghError(err)
			case text == "":
				info.LogWhy = "GitHub kept no failed step log for it"
			default:
				info.Log = "untrusted.cilogs"
				logs = append(logs, ciLogText{Check: check.Name, Url: check.Url, Excerpt: maskTokens(FailureExcerpt(text))})
			}
		}
		checks = append(checks, info)
	}
	return checks, logs
}
