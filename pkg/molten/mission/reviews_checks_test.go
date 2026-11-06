// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"encoding/json"
	"strings"
	"testing"
)

// The rollup of PR #795 as gh printed it (#797): the draft's run 38921213302 skipped the jobs, the ready one
// 38921294428 ran them, and GitHub lists the old entries after the new ones. backend is the new Backend entry.
func pr795Rollup(backend string) string {
	return `[
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:06:25Z","conclusion":"SKIPPED","detailsUrl":"https://github.com/o/r/actions/runs/38921212438/job/117041300281","name":"sync-review","startedAt":"2026-10-16T15:06:25Z","status":"COMPLETED","workflowName":"Sync PR review status"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:06:39Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/38921213302/job/117041298621","name":"Quick checks","startedAt":"2026-10-16T15:06:28Z","status":"COMPLETED","workflowName":"CI"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:07:13Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/38921294428/job/117050341442","name":"Quick checks","startedAt":"2026-10-16T15:07:05Z","status":"COMPLETED","workflowName":"CI"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:07:14Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/38921295151/job/117041586417","name":"sync-review","startedAt":"2026-10-16T15:07:06Z","status":"COMPLETED","workflowName":"Sync PR review status"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:06:25Z","conclusion":"SKIPPED","detailsUrl":"https://github.com/o/r/actions/runs/38921213302/job/117041301118","name":"Frontend","startedAt":"2026-10-16T15:06:25Z","status":"COMPLETED","workflowName":"CI"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:10:27Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/38921294428/job/117050300447","name":"Frontend","startedAt":"2026-10-16T15:07:05Z","status":"COMPLETED","workflowName":"CI"},
 ` + backend + `,
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:06:25Z","conclusion":"SKIPPED","detailsUrl":"https://github.com/o/r/actions/runs/38921213302/job/117041301233","name":"Backend","startedAt":"2026-10-16T15:06:25Z","status":"COMPLETED","workflowName":"CI"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:06:25Z","conclusion":"SKIPPED","detailsUrl":"https://github.com/o/r/actions/runs/38921213302/job/117041300564","name":"Perf budgets","startedAt":"2026-10-16T15:06:25Z","status":"COMPLETED","workflowName":"CI"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:15:32Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/38921294428/job/117050301282","name":"Perf budgets","startedAt":"2026-10-16T15:07:05Z","status":"COMPLETED","workflowName":"CI"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:16:00Z","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/38921294428/job/117050298872","name":"Required gate","startedAt":"2026-10-16T15:15:52Z","status":"COMPLETED","workflowName":"CI"},
 {"__typename":"CheckRun","completedAt":"2026-10-16T15:06:52Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/38921213302/job/117041298266","name":"Required gate","startedAt":"2026-10-16T15:06:28Z","status":"COMPLETED","workflowName":"CI"}
]`
}

const pr795BackendFailed = `{"__typename":"CheckRun","completedAt":"2026-10-16T15:15:50Z","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/38921294428/job/117050298920","name":"Backend","startedAt":"2026-10-16T15:07:05Z","status":"COMPLETED","workflowName":"CI"}`

func foldRollup(t *testing.T, raw string) ReviewCi {
	t.Helper()
	ci, err := ParseReviewChecks(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	return ci
}

func checkOf(ci ReviewCi, name string) ReviewCheck {
	for _, c := range ci.Checks {
		if c.Name == name {
			return c
		}
	}
	return ReviewCheck{}
}

// #797: the old skipped Backend listed after the failed one hid the failure, and the row said "5 passed".
func TestSummarizeReviewChecksLatestRunWins(t *testing.T) {
	t.Parallel()
	ci := foldRollup(t, pr795Rollup(pr795BackendFailed))
	if ci.State != ReviewCheckFailure || ci.Failure != 2 || ci.Success != 4 || ci.Pending != 0 {
		t.Fatalf("got %+v", ci)
	}
	backend := checkOf(ci, "Backend")
	if backend.State != ReviewCheckFailure || backend.Workflow != "CI" || backend.RunId != 38921294428 || backend.JobId != 117050298920 {
		t.Errorf("Backend: %+v", backend)
	}
	if !strings.HasSuffix(backend.Url, "/job/117050298920") {
		t.Errorf("Backend url: %s", backend.Url)
	}
	if gate := checkOf(ci, "Required gate"); gate.State != ReviewCheckFailure {
		t.Errorf("Required gate: %+v", gate)
	}
}

func TestSummarizeReviewChecksRerunIsPending(t *testing.T) {
	t.Parallel()
	rerun := `{"__typename":"CheckRun","completedAt":"0001-01-01T00:00:00Z","conclusion":"","detailsUrl":"https://github.com/o/r/actions/runs/38921294428/job/117099999999","name":"Backend","startedAt":"2026-10-16T15:25:52Z","status":"IN_PROGRESS","workflowName":"CI"}`
	ci := foldRollup(t, pr795Rollup(rerun+","+pr795BackendFailed))
	if backend := checkOf(ci, "Backend"); backend.State != ReviewCheckPending || backend.JobId != 117099999999 {
		t.Errorf("Backend: %+v", backend)
	}
	queued := `{"__typename":"CheckRun","completedAt":"0001-01-01T00:00:00Z","conclusion":"","name":"Backend","startedAt":"0001-01-01T00:00:00Z","status":"QUEUED","workflowName":"CI"}`
	ci = foldRollup(t, pr795Rollup(queued+","+pr795BackendFailed))
	if backend := checkOf(ci, "Backend"); backend.State != ReviewCheckPending {
		t.Errorf("a queued rerun: %+v", backend)
	}
}

// #1876: the card says since when the CI is over, so a finished check carries when it finished and a running one does not.
func TestSummarizeReviewChecksKeepsWhenAFinishedCheckEnded(t *testing.T) {
	t.Parallel()
	ci := foldRollup(t, `[{"name":"Backend","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-04T08:00:00Z","completedAt":"2026-11-04T08:07:30Z"},
		{"name":"Frontend","workflowName":"CI","status":"IN_PROGRESS","conclusion":"","startedAt":"2026-11-04T08:00:00Z","completedAt":"0001-01-01T00:00:00Z"},
		{"__typename":"StatusContext","context":"local-ci","state":"SUCCESS","startedAt":"2026-11-04T08:00:00Z"}]`)
	if got := checkOf(ci, "Backend").CompletedAt; got != "2026-11-04T08:07:30Z" {
		t.Errorf("a finished check says when: %q", got)
	}
	if got := checkOf(ci, "Frontend").CompletedAt; got != "" {
		t.Errorf("a running check has no end: %q", got)
	}
	if got := checkOf(ci, "local-ci").CompletedAt; got != "" {
		t.Errorf("a status has no end time: %q", got)
	}
}

// Two workflows may name a job alike: both are checks of their own.
func TestSummarizeReviewChecksKeysByWorkflow(t *testing.T) {
	t.Parallel()
	ci := foldRollup(t, `[{"name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-10-16T10:00:00Z"},
		{"name":"build","workflowName":"Release","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-16T09:00:00Z"},
		{"__typename":"StatusContext","context":"local-ci","state":"SUCCESS","startedAt":"2026-10-16T08:00:00Z","targetUrl":"https://example.com/x"}]`)
	if len(ci.Checks) != 3 || ci.Failure != 1 || ci.Success != 2 {
		t.Fatalf("got %+v", ci)
	}
	if local := checkOf(ci, "local-ci"); !local.Local || local.Url != "https://example.com/x" || local.RunId != 0 {
		t.Errorf("local-ci: %+v", local)
	}
}
