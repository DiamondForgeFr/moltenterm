// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
)

// ghLog writes lines as gh run view --log-failed prints them: job, step, time, then the line.
func ghLog(job string, step string, lines ...string) string {
	var b strings.Builder
	for _, line := range lines {
		fmt.Fprintf(&b, "%s\t%s\t2026-10-16T15:12:01.1234567Z %s\n", job, step, line)
	}
	return b.String()
}

func noise(n int, prefix ...string) []string {
	var rtn []string
	for i := 0; i < n; i++ {
		rtn = append(rtn, fmt.Sprintf("ok  \tgithub.com/acme/app/pkg/%sp%d\t0.%03ds", strings.Join(prefix, ""), i, i))
	}
	return rtn
}

// #797 AC3: a Go job's excerpt keeps the --- FAIL lines and the messages after them, without gh's prefixes.
func TestFailureExcerptGo(t *testing.T) {
	lines := append(noise(80),
		"--- FAIL: TestRunCodexAppServerErrors (31.02s)",
		"    codex_test.go:212: took 31s, want < 30s",
		"FAIL",
		"FAIL\tgithub.com/acme/app/pkg/molten/agent\t33.120s",
	)
	lines = append(lines, noise(80, "after")...)
	lines = append(lines, "##[error]Process completed with exit code 1.")
	got := FailureExcerpt(ghLog("Backend", "Go tests", lines...))
	for _, want := range []string{"--- FAIL: TestRunCodexAppServerErrors", "codex_test.go:212: took 31s", "FAIL\tgithub.com/acme/app/pkg/molten/agent", "##[error]Process completed"} {
		if !strings.Contains(got, want) {
			t.Errorf("the excerpt misses %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "Backend\t") || strings.Contains(got, "2026-10-16T") {
		t.Errorf("gh's prefixes stayed:\n%s", got)
	}
	if strings.Contains(got, "pkg/p10\t") || !strings.Contains(got, "…") {
		t.Errorf("the passing packages far from the failure stayed, or no gap is marked:\n%s", got)
	}
	if len(got) > maxExcerptBytes {
		t.Errorf("%d bytes", len(got))
	}
}

// A vitest job's excerpt names the failing test and its assertion; colour codes go.
func TestFailureExcerptVitest(t *testing.T) {
	lines := append(noise(50),
		"\x1b[31m FAIL \x1b[39m frontend/moltenterm-shell/reviews/reviews-model.test.ts > ciLabel > names the failed checks",
		"AssertionError: expected 'CI 5 passed' to be 'CI: Backend failed'",
		" ❯ frontend/moltenterm-shell/reviews/reviews-model.test.ts:42:9",
		"",
		" Test Files  1 failed | 211 passed (212)",
		"      Tests  1 failed | 3020 passed (3021)",
	)
	got := FailureExcerpt(ghLog("Frontend", "Vitest", lines...))
	for _, want := range []string{"FAIL  frontend/moltenterm-shell/reviews/reviews-model.test.ts > ciLabel", "AssertionError: expected", "Tests  1 failed"} {
		if !strings.Contains(got, want) {
			t.Errorf("the excerpt misses %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "\x1b[") {
		t.Errorf("colour codes stayed:\n%s", got)
	}
}

// With no failure line to anchor on, the log's tail tells the most.
func TestFailureExcerptTail(t *testing.T) {
	got := FailureExcerpt(ghLog("Build", "Package", append(noise(100), "the disk is full")...))
	if !strings.HasPrefix(got, "…\n") || !strings.HasSuffix(got, "the disk is full") || strings.Contains(got, "pkg/p10\t") {
		t.Errorf("tail:\n%s", got)
	}
}

// #797 AC3: review_context names each failed check with its run's page; the excerpt of its failed log is under
// untrusted, read through gh naming the repository.
func TestContextFailedChecks(t *testing.T) {
	f := makeFakeWave()
	f.gh["pr view"] = `{"url":"https://github.com/Owner/Repo/pull/7","body":"x","headRefName":"feature/7-x","comments":[],"closingIssuesReferences":[],
"statusCheckRollup":[
 {"name":"Backend","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-16T15:07:05Z","detailsUrl":"https://github.com/Owner/Repo/actions/runs/38921294428/job/117050298920"},
 {"name":"Backend","workflowName":"CI","status":"COMPLETED","conclusion":"SKIPPED","startedAt":"2026-10-16T15:06:25Z","detailsUrl":"https://github.com/Owner/Repo/actions/runs/38921213302/job/117041301233"},
 {"__typename":"StatusContext","context":"local-ci","state":"FAILURE","targetUrl":"https://example.com/local"},
 {"name":"Frontend","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-10-16T15:07:05Z"}]}`
	f.gh["run view"] = ghLog("Backend", "Go tests", "--- FAIL: TestFlaky (31.02s)", "    flaky_test.go:9: took too long")
	out := readContext(t, startLive(t, f, nil))
	if out.Ci.State != "failure" || out.Ci.Failure != 2 || len(out.Ci.Checks) != 2 {
		t.Fatalf("ci %+v", out.Ci)
	}
	backend := out.Ci.Checks[0]
	if backend.Name != "Backend" || backend.Workflow != "CI" || backend.Log != "untrusted.cilogs" || !strings.HasSuffix(backend.Url, "/job/117050298920") {
		t.Errorf("Backend %+v", backend)
	}
	if local := out.Ci.Checks[1]; local.Name != "local-ci" || local.Log != "" || local.LogWhy == "" || local.Url != "https://example.com/local" {
		t.Errorf("local-ci %+v", local)
	}
	if len(out.Untrusted.CiLogs) != 1 || out.Untrusted.CiLogs[0].Check != "Backend" || !strings.Contains(out.Untrusted.CiLogs[0].Excerpt, "flaky_test.go:9: took too long") {
		t.Errorf("logs %+v", out.Untrusted.CiLogs)
	}
	var read string
	for _, call := range f.ghCalls {
		if call[0] == "run" {
			read = strings.Join(call, " ")
		}
	}
	if read != "run view --job 117050298920 --log-failed -R Owner/Repo" {
		t.Errorf("log read with %q", read)
	}
}

// #797: the guide names, in both interface languages, the buttons that do what the session cannot; the labels are the
// interface's own.
func TestGuideNamesTheButtons(t *testing.T) {
	guide, err := agentdocs.Files.ReadFile(agentdocs.ReviewGuideFile)
	if err != nil {
		t.Fatal(err)
	}
	locales := filepath.Join("..", "..", "..", "frontend", "moltenterm-shell", "i18n", "locales")
	for _, lang := range []string{"en", "fr"} {
		data, err := os.ReadFile(filepath.Join(locales, lang+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var texts map[string]any
		if err := json.Unmarshal(data, &texts); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"reviews.rebase.button", "reviews.ci.rerun.button", "reviews.ci.investigate.button",
			"review.restart.button", "reviews.validate.button", "reviews.ready.button"} {
			var node any = texts
			for _, part := range strings.Split(key, ".") {
				node, _ = node.(map[string]any)[part]
			}
			label, _ := node.(string)
			if label == "" || !strings.Contains(string(guide), "**"+label+"**") {
				t.Errorf("the guide does not name %s's %s (%q)", lang, key, label)
			}
		}
	}
	for _, want := range []string{"untrusted.cilogs", "do not ask them to paste"} {
		if !strings.Contains(string(guide), want) {
			t.Errorf("the guide misses %q", want)
		}
	}
}

// A long failure is cut to its budget, and says so.
func TestFailureExcerptCut(t *testing.T) {
	var lines []string
	for i := 0; i < 200; i++ {
		lines = append(lines, fmt.Sprintf("--- FAIL: TestNumber%d (0.00s) %s", i, strings.Repeat("x", 40)))
	}
	got := FailureExcerpt(ghLog("Backend", "Go tests", lines...))
	if len(got) > maxExcerptBytes+len("[cut]") || !strings.HasSuffix(got, "[cut]") || !strings.Contains(got, "TestNumber0 ") {
		t.Errorf("%d bytes:\n%s", len(got), got)
	}
}
