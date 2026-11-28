// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// A trunk that is red with no open pull request is a block too (FR-REV-036 AC16): the scan the project declared or the
// developer confirmed fails on the trunk's head, and the advisories it names are read as for a pull request.

// withTrunkChecks answers the trunk's check runs and leaves everything else to the scenario.
func (s *scenario) withTrunkChecks(runs ...string) Gh {
	body := `{"check_runs":[` + strings.Join(runs, ",") + `]}`
	return func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		if len(args) > 1 && args[0] == "api" && strings.Contains(args[1], "/check-runs") {
			s.lock.Lock()
			s.calls = append(s.calls, strings.Join(args, " "))
			s.lock.Unlock()
			return []byte(body), nil
		}
		return s.gh(ctx, dir, args...)
	}
}

func trunkRun(name string, conclusion string, run int64, job int64) string {
	return fmt.Sprintf(`{"name":%q,"conclusion":%q,"html_url":"https://github.com/o/r/actions/runs/%d/job/%d"}`, name, conclusion, run, job)
}

func TestAssessReadsATrunkThatIsRedWithNoOpenPullRequest(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[901] = blockedReport(t, "GO-2099-0001", "GO-2099-0002")
	gh := s.withTrunkChecks(trunkRun("Quick checks", "failure", 901, 9012), trunkRun(scanName, "failure", 901, 9011), trunkRun("Frontend", "success", 901, 9013))
	in := Input{Dir: "/p", Trunk: "develop", WatchTrunk: true, Policy: declaredPolicy()}
	if in.Key() == "" {
		t.Fatal("a project that names its scan has its trunk read, with no pull request at all")
	}
	result := MakeReader().Assess(context.Background(), gh, in)
	if len(result.Blocks) != 1 || len(result.Offers) != 0 || len(result.Unread) != 0 {
		t.Fatalf("result = %+v", result)
	}
	block := result.Blocks[0]
	if !reflect.DeepEqual(ids(block), []string{"GO-2099-0001", "GO-2099-0002"}) || block.Fingerprint != Fingerprint([]string{"GO-2099-0001", "GO-2099-0002"}) {
		t.Fatalf("the block's set = %v (%s)", ids(block), block.Fingerprint)
	}
	if !block.Shared || !block.TrunkFailing || block.TrunkRun != 901 || block.Origin != OriginDeclared || block.Source != SourceReport || block.Check != scanName {
		t.Fatalf("block = %+v", block)
	}
	if block.Prs == nil || len(block.Prs) != 0 {
		t.Fatalf("no pull request is blocked, and the wire says so with an empty list: %#v", block.Prs)
	}
	if kept := result.Restrict(map[int]bool{}); len(kept.Blocks) != 1 {
		t.Fatalf("no pull request leaving can end the trunk's own block: %+v", kept)
	}
	if got := result.PrOfBlock(7); got != "" {
		t.Fatalf("no pull request is in it: %q", got)
	}
}

// The trunk's block is not a second block for the advisories a pull request's block holds already.
func TestAssessDoesNotDuplicateWhatAPullRequestBlockHolds(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[111] = blockedReport(t, "GO-2099-0001")
	s.reports[901] = blockedReport(t, "GO-2099-0001")
	s.trunkRuns = []int64{901}
	s.trunkJobs[901] = []fakeJob{{Id: 9011, Name: scanName, Conclusion: "failure"}}
	s.files[11] = []string{"docs/readme.md"}
	gh := s.withTrunkChecks(trunkRun(scanName, "failure", 901, 9011))
	in := Input{Dir: "/p", Trunk: "develop", WatchTrunk: true, Policy: declaredPolicy(), Prs: []PrInput{{Number: 11, HeadOid: "aaa", Checks: []Check{failedScan(111)}}}}
	result := MakeReader().Assess(context.Background(), gh, in)
	if len(result.Blocks) != 1 || len(result.Blocks[0].Prs) != 1 {
		t.Fatalf("one block, the pull request's, which says the trunk fails too: %+v", result.Blocks)
	}
	// Other advisories on the trunk are a block of their own.
	s.reports[902] = blockedReport(t, "GO-2099-0003")
	gh = s.withTrunkChecks(trunkRun(scanName, "failure", 902, 9021))
	result = MakeReader().Assess(context.Background(), gh, in)
	if len(result.Blocks) != 2 || len(result.Blocks[1].Prs) != 0 || !reflect.DeepEqual(ids(result.Blocks[1]), []string{"GO-2099-0003"}) {
		t.Fatalf("the trunk's other advisories: %+v", result.Blocks)
	}
}

func TestAssessReadsAConfirmedScanOnTheTrunkFromItsLog(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.logs[7001] = "##[error]GHSA-aaaa-bbbb-cccc left-pad@1.0.0 is vulnerable\n"
	gh := s.withTrunkChecks(trunkRun("Security audit", "timed_out", 700, 7001))
	in := Input{Dir: "/p", Trunk: "develop", WatchTrunk: true, Policy: Policy{Confirmed: []string{"Security audit"}}}
	result := MakeReader().Assess(context.Background(), gh, in)
	if len(result.Blocks) != 1 || result.Blocks[0].Origin != OriginConfirmed || result.Blocks[0].Source != SourceLog || !result.Blocks[0].TrunkFailing {
		t.Fatalf("a confirmed scan, read from its log: %+v", result.Blocks)
	}
}

// Nothing is guessed on the trunk: a check that only looks like a scan, a local status, a scan that passes or that names
// no advisory make no block, and a project that names no scan reads nothing.
func TestAssessMakesNoTrunkBlockOnAGuess(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	gh := s.withTrunkChecks(trunkRun("Security audit", "failure", 700, 7001), trunkRun("local-security", "failure", 701, 7011), trunkRun(scanName, "success", 702, 7021))
	for name, policy := range map[string]Policy{
		"a heuristic match":             {},
		"a dismissed check":             {Dismissed: []string{"Security audit"}},
		"a declared scan that passes":   declaredPolicy(),
		"a declaration with no checks":  {Declaration: &Declaration{}},
		"a confirmed check that passed": {Confirmed: []string{scanName}},
	} {
		in := Input{Dir: "/p", Trunk: "develop", WatchTrunk: true, Policy: policy}
		if result := MakeReader().Assess(context.Background(), gh, in); len(result.Blocks) != 0 {
			t.Errorf("%s: %+v", name, result.Blocks)
		}
	}
	// Only the projects that name a scan read their trunk: the declared one and the confirmed one, once each.
	if got := s.count("api"); got != 2 {
		t.Errorf("trunk reads = %d, want 2", got)
	}
	// A scan that fails with no advisory to read makes no block.
	s = makeScenario(t)
	s.reports[901] = []byte(`{"schema":1,"status":"scanner-input-failure","findings":[]}`)
	gh = s.withTrunkChecks(trunkRun(scanName, "failure", 901, 9011))
	if result := MakeReader().Assess(context.Background(), gh, Input{Dir: "/p", Trunk: "develop", WatchTrunk: true, Policy: declaredPolicy()}); len(result.Blocks) != 0 {
		t.Fatalf("a scan that could not run has nothing to fix: %+v", result.Blocks)
	}
}

// The trunk is read only when the assessment is asked to watch it: an assessment of a pull request's failed scan alone
// reads what that failure leads to.
func TestAssessWatchesTheTrunkOnlyWhenAsked(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	gh := s.withTrunkChecks(trunkRun(scanName, "failure", 901, 9011))
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy()}
	if in.Key() != "" || in.HasFailedScan() {
		t.Fatalf("key %q: nothing fails, nothing is watched", in.Key())
	}
	if result := MakeReader().Assess(context.Background(), gh, in); len(result.Blocks) != 0 || len(s.calls) != 0 {
		t.Fatalf("an assessment that does not watch the trunk reads nothing of it: %+v %v", result, s.calls)
	}
	in.WatchTrunk = true
	watching := in.Key()
	if watching == "" || in.HasFailedScan() {
		t.Fatalf("a watched trunk has a key, and still no failed scan on a pull request: %q", watching)
	}
	in.Policy = Policy{}
	if in.Key() != "" {
		t.Fatal("a project that names no scan has no trunk to watch")
	}
	in.Policy = declaredPolicy()
	in.Prs = []PrInput{{Number: 5, HeadOid: "a", Checks: []Check{failedScan(55)}}}
	if !in.HasFailedScan() || in.Key() == watching {
		t.Fatal("a failed scan on a pull request is another key")
	}
}

func TestResultTrunkOnlyKeepsTheBlocksWithNoPullRequest(t *testing.T) {
	t.Parallel()
	result := Result{Blocks: []Block{
		{Fingerprint: "aaaa", Prs: []BlockPr{{Number: 1}}},
		{Fingerprint: "bbbb", Prs: []BlockPr{}, TrunkFailing: true},
	}, Offers: []Offer{{Check: "x"}}, Unread: []Unread{{Pr: 1}}}
	only := result.TrunkOnly()
	if len(only.Blocks) != 1 || only.Blocks[0].Fingerprint != "bbbb" || len(only.Offers) != 0 || len(only.Unread) != 0 {
		t.Fatalf("trunk only: %+v", only)
	}
}

func TestAssessSaysNothingOfATrunkItCannotRead(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	failing := func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		s.lock.Lock()
		s.calls = append(s.calls, strings.Join(args, " "))
		s.lock.Unlock()
		return nil, errors.New("HTTP 502")
	}
	reader := MakeReader()
	in := Input{Dir: "/p", Trunk: "develop", WatchTrunk: true, Policy: declaredPolicy()}
	for i := 0; i < 3; i++ {
		if result := reader.Assess(context.Background(), failing, in); len(result.Blocks) != 0 {
			t.Fatalf("blocks: %+v", result.Blocks)
		}
	}
	if s.count("api") != 1 {
		t.Fatalf("a read that failed is not repeated at each refresh: %v", s.calls)
	}
}
