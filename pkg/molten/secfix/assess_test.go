// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const scanName = "Dependency security / Scan dependencies"

type fakeJob struct {
	Id         int64
	Name       string
	Conclusion string
}

// scenario is a project's GitHub: the artifacts and logs of its runs, the trunk's runs and the files of its pull
// requests, read through a fake gh that counts what it was asked.
type scenario struct {
	lock sync.Mutex
	t    *testing.T
	// The report a run's artifact holds, by run id.
	reports map[int64][]byte
	// The failed log of a job, by job id.
	logs      map[int64]string
	trunkRuns []int64
	trunkJobs map[int64][]fakeJob
	files     map[int][]string
	calls     []string
}

func makeScenario(t *testing.T) *scenario {
	return &scenario{t: t, reports: map[int64][]byte{}, logs: map[int64]string{}, trunkJobs: map[int64][]fakeJob{}, files: map[int][]string{}}
}

func (s *scenario) count(prefix string) int {
	s.lock.Lock()
	defer s.lock.Unlock()
	n := 0
	for _, call := range s.calls {
		if strings.HasPrefix(call, prefix) {
			n++
		}
	}
	return n
}

func (s *scenario) gh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	s.lock.Lock()
	s.calls = append(s.calls, strings.Join(args, " "))
	s.lock.Unlock()
	if len(args) < 2 {
		return nil, errors.New("unexpected gh call")
	}
	switch {
	case args[0] == "run" && args[1] == "download":
		run, _ := strconv.ParseInt(args[2], 10, 64)
		report, ok := s.reports[run]
		if !ok {
			return nil, errors.New("no valid artifacts found to download")
		}
		target := ""
		for _, arg := range args {
			if strings.HasPrefix(arg, "--dir=") {
				target = strings.TrimPrefix(arg, "--dir=")
			}
		}
		folder := filepath.Join(target, fmt.Sprintf("dependency-security-%d-1", run))
		if err := os.MkdirAll(folder, 0755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(folder, "manifest.json"), []byte(`{"schema":1}`), 0644); err != nil {
			return nil, err
		}
		return nil, os.WriteFile(filepath.Join(folder, "report.json"), report, 0644)
	case args[0] == "run" && args[1] == "view" && contains(args, "--log-failed"):
		for i, arg := range args {
			if arg == "--job" {
				job, _ := strconv.ParseInt(args[i+1], 10, 64)
				if log, ok := s.logs[job]; ok {
					return []byte(log), nil
				}
			}
		}
		return nil, errors.New("log not found")
	case args[0] == "run" && args[1] == "view" && contains(args, "--json=jobs"):
		run, _ := strconv.ParseInt(args[2], 10, 64)
		jobs := []map[string]any{}
		for _, job := range s.trunkJobs[run] {
			jobs = append(jobs, map[string]any{"databaseId": job.Id, "name": job.Name, "conclusion": job.Conclusion, "status": "completed"})
		}
		return json.Marshal(map[string]any{"jobs": jobs})
	case args[0] == "run" && args[1] == "list":
		items := []map[string]any{}
		for _, run := range s.trunkRuns {
			items = append(items, map[string]any{"databaseId": run})
		}
		return json.Marshal(items)
	case args[0] == "api":
		var number int
		fmt.Sscanf(args[1], "repos/{owner}/{repo}/pulls/%d/files", &number)
		files, ok := s.files[number]
		if !ok {
			return nil, errors.New("not found")
		}
		return []byte(strings.Join(files, "\n") + "\n"), nil
	}
	return nil, fmt.Errorf("unexpected gh call: %v", args)
}

func contains(list []string, word string) bool {
	for _, item := range list {
		if item == word {
			return true
		}
	}
	return false
}

func declaredPolicy() Policy {
	return Policy{Declaration: &Declaration{
		Checks:          []string{scanName},
		Report:          &ReportSpec{Artifact: "dependency-security-*", File: "report.json", Format: FormatMoltenterm},
		DependencyFiles: []string{"security/dependencies.json"},
	}}
}

func failedScan(run int64) Check {
	return Check{Name: scanName, Workflow: "CI", Failed: true, RunId: run, JobId: run*10 + 1}
}

func blockedReport(t *testing.T, ids ...string) []byte {
	t.Helper()
	findings := []map[string]any{}
	for _, id := range ids {
		findings = append(findings, map[string]any{"ecosystem": "go", "id": id, "package": "example.com/fake/lib", "version": "v1.2.0",
			"fixedVersion": "1.2.4", "severity": "high", "title": "Fake advisory " + id, "verdict": "blocked"})
	}
	data, err := json.Marshal(map[string]any{"schema": 1, "status": "blocked-policy", "findings": findings})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func ids(block Block) []string {
	return Ids(block.Advisories)
}

func prReasons(block Block, number int) []string {
	for _, pr := range block.Prs {
		if pr.Number == number {
			return pr.Reasons
		}
	}
	return nil
}

func TestAssessSharedBlockOnTheTrunkAndSeveralPrs(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	for _, run := range []int64{111, 112} {
		s.reports[run] = blockedReport(t, "GO-2099-0001")
	}
	// The third pull request's report expired: its failed log still names the advisory.
	s.logs[1131] = "##[error]GO-2099-0001 example.com/fake/lib@v1.2.0 runtime: no assessment\n"
	s.trunkRuns = []int64{901}
	s.trunkJobs[901] = []fakeJob{{Id: 9011, Name: scanName, Conclusion: "failure"}}
	s.reports[901] = blockedReport(t, "GO-2099-0001")
	s.files[11] = []string{"pkg/a.go", "go.mod"}
	s.files[12] = []string{"docs/readme.md"}
	s.files[13] = []string{"security/dependencies.json"}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{
		{Number: 11, HeadOid: "aaa", Checks: []Check{failedScan(111), {Name: "Quick checks", Workflow: "CI", Failed: true, RunId: 111, JobId: 1}}},
		{Number: 12, HeadOid: "bbb", Checks: []Check{failedScan(112)}},
		{Number: 13, HeadOid: "ccc", Checks: []Check{failedScan(113)}},
	}}
	result := MakeReader().Assess(context.Background(), s.gh, in)
	if len(result.Blocks) != 1 || len(result.Offers) != 0 || len(result.Unread) != 0 {
		t.Fatalf("result = %+v", result)
	}
	block := result.Blocks[0]
	if !reflect.DeepEqual(ids(block), []string{"GO-2099-0001"}) || block.Fingerprint != Fingerprint([]string{"GO-2099-0001"}) {
		t.Fatalf("the block's set = %v (%s)", ids(block), block.Fingerprint)
	}
	if !block.Shared || !block.TrunkFailing || block.TrunkRun != 901 || block.Origin != OriginDeclared || block.Check != scanName {
		t.Fatalf("block = %+v", block)
	}
	if block.Source != SourceLog {
		t.Fatalf("one of its pull requests was read from a log, the block says %q", block.Source)
	}
	if block.Advisories[0].Package != "example.com/fake/lib" || block.Advisories[0].Fixed != "1.2.4" {
		t.Fatalf("the report's facts complete the log's id: %+v", block.Advisories)
	}
	want := map[int][]string{
		11: {ReasonTrunk, ReasonPrs},
		12: {ReasonTrunk, ReasonPrs, ReasonNoDependencyChange},
		13: {ReasonTrunk, ReasonPrs},
	}
	for number, reasons := range want {
		if got := prReasons(block, number); !reflect.DeepEqual(got, reasons) {
			t.Errorf("#%d reasons = %v, want %v", number, got, reasons)
		}
	}
	if !reflect.DeepEqual(block.Prs[0].Checks, []string{scanName}) {
		t.Fatalf("only the scan is listed among the checks: %v", block.Prs[0].Checks)
	}
	if result.PrOfBlock(12) != block.Fingerprint || result.PrOfBlock(99) != "" {
		t.Fatalf("PrOfBlock = %q, %q", result.PrOfBlock(12), result.PrOfBlock(99))
	}
}

func TestAssessAPrThatBroughtTheAdvisoryItselfIsNotShared(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[211] = blockedReport(t, "GO-2099-0001")
	s.trunkRuns = []int64{901}
	s.trunkJobs[901] = []fakeJob{{Id: 9011, Name: scanName, Conclusion: "success"}}
	s.files[21] = []string{"go.mod", "go.sum"}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 21, HeadOid: "aaa", Checks: []Check{failedScan(211)}}}}
	result := MakeReader().Assess(context.Background(), s.gh, in)
	if len(result.Blocks) != 1 {
		t.Fatalf("result = %+v", result)
	}
	block := result.Blocks[0]
	if block.Shared || block.TrunkFailing || len(block.Prs[0].Reasons) != 0 || block.Prs[0].Shared {
		t.Fatalf("a pull request that changes go.mod on a green trunk caused its failure: %+v", block)
	}
}

func TestAssessATrunkFailureOfAnotherSetIsNotThePrs(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[311] = blockedReport(t, "GO-2099-0001", "GO-2099-0002")
	s.trunkRuns = []int64{901}
	s.trunkJobs[901] = []fakeJob{{Id: 9011, Name: scanName, Conclusion: "failure"}}
	s.reports[901] = blockedReport(t, "GO-2099-0001")
	s.files[31] = []string{"go.mod"}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 31, HeadOid: "aaa", Checks: []Check{failedScan(311)}}}}
	result := MakeReader().Assess(context.Background(), s.gh, in)
	block := result.Blocks[0]
	// The trunk fails on one of the two advisories: the other is the pull request's own, so its block is not shared, but
	// a fix of the trunk's set is part of it.
	if block.Shared || !block.TrunkFailing || !reflect.DeepEqual(ids(block), []string{"GO-2099-0001", "GO-2099-0002"}) {
		t.Fatalf("block = %+v", block)
	}
}

func TestAssessAPrThatChangesNoDependencyFileIsSharedWhateverTheTrunk(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[411] = blockedReport(t, "GO-2099-0001")
	s.trunkJobs[901] = []fakeJob{{Id: 9011, Name: scanName, Conclusion: "skipped"}}
	s.trunkJobs[900] = []fakeJob{{Id: 9001, Name: scanName, Conclusion: "success"}}
	s.trunkRuns = []int64{901, 900}
	s.files[41] = []string{"frontend/app.tsx"}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 41, HeadOid: "aaa", Checks: []Check{failedScan(411)}}}}
	block := MakeReader().Assess(context.Background(), s.gh, in).Blocks[0]
	if !block.Shared || !reflect.DeepEqual(prReasons(block, 41), []string{ReasonNoDependencyChange}) || block.TrunkFailing {
		t.Fatalf("a skipped trunk run says nothing, the next one is green: %+v", block)
	}
}

func TestAssessUnknownFilesNeverMakeABlockShared(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[511] = blockedReport(t, "GO-2099-0001")
	s.trunkRuns = []int64{}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 51, HeadOid: "aaa", Checks: []Check{failedScan(511)}}}}
	block := MakeReader().Assess(context.Background(), s.gh, in).Blocks[0]
	if block.Shared {
		t.Fatalf("with the files unreadable and the trunk unknown, nothing says the failure is shared: %+v", block)
	}
}

func TestAssessOffersAHeuristicMatchAndActsOnItOnlyOnceConfirmed(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.logs[611] = "##[error]GO-2099-0001 example.com/fake/lib@v1.2.0\n"
	s.logs[621] = "##[error]ghsa-aaaa-bbbb-cccc left-fake\n##[error]GO-2099-0001 again\n"
	s.logs[631] = "tests failed: expected 3, got 4\n"
	s.trunkRuns = []int64{}
	audit := func(run int64) Check {
		return Check{Name: "Security audit", Workflow: "Audit", Failed: true, RunId: run, JobId: run*10 + 1}
	}
	prs := []PrInput{
		{Number: 61, HeadOid: "a", Checks: []Check{audit(61), {Name: "Unit tests", Workflow: "CI", Failed: true, RunId: 61, JobId: 5}}},
		{Number: 62, HeadOid: "b", Checks: []Check{audit(62)}},
		{Number: 63, HeadOid: "c", Checks: []Check{{Name: "Security headers test", Workflow: "CI", Failed: true, RunId: 63, JobId: 631}}},
	}
	in := Input{Dir: "/p", Trunk: "develop", Prs: prs}
	result := MakeReader().Assess(context.Background(), s.gh, in)
	if len(result.Blocks) != 0 {
		t.Fatalf("a guess acts on nothing: %+v", result.Blocks)
	}
	want := []Offer{{Check: "Security audit", Workflow: "Audit", Ids: []string{"GHSA-aaaa-bbbb-cccc", "GO-2099-0001"}, Prs: []int{61, 62}}}
	if !reflect.DeepEqual(result.Offers, want) {
		t.Fatalf("offers = %+v, want %+v", result.Offers, want)
	}
	if s.count("run list") != 0 {
		t.Fatal("the trunk is not read for a check nobody confirmed")
	}

	in.Policy = Policy{Confirmed: []string{"security audit"}}
	confirmed := MakeReader().Assess(context.Background(), s.gh, in)
	if len(confirmed.Offers) != 0 {
		t.Fatalf("the headers test names no advisory, so it is not offered: %+v", confirmed.Offers)
	}
	if len(confirmed.Blocks) != 1 || confirmed.Blocks[0].Origin != OriginConfirmed || confirmed.Blocks[0].Source != SourceLog || len(confirmed.Blocks[0].Prs) != 2 {
		t.Fatalf("a confirmed check is the project's scan, read from its log: %+v", confirmed.Blocks)
	}

	in.Policy = Policy{Dismissed: []string{"Security audit"}}
	dismissed := MakeReader().Assess(context.Background(), s.gh, in)
	if len(dismissed.Blocks) != 0 || len(dismissed.Offers) != 0 {
		t.Fatalf("a check the developer said is not the scan is neither offered nor acted on: %+v", dismissed)
	}
}

func TestAssessNeverClassifiesWhatIsNotAFailedScan(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 71, HeadOid: "a", Checks: []Check{
		{Name: scanName, Workflow: "CI", Failed: false, RunId: 711, JobId: 1},
		{Name: "local-vitest", Workflow: "", Local: true, Failed: true},
		{Name: "AI testing / Local CI", Failed: true},
		{Name: "Quick checks", Workflow: "CI", Failed: true, RunId: 711, JobId: 2},
	}}}}
	if key := in.Key(); key != "" {
		t.Fatalf("no failed check could be the scan, yet the key is %q", key)
	}
	result := MakeReader().Assess(context.Background(), s.gh, in)
	if len(result.Blocks)+len(result.Offers)+len(result.Unread) != 0 || len(s.calls) != 0 {
		t.Fatalf("nothing is read: %+v, calls %v", result, s.calls)
	}
}

func TestAssessReadsEachRunAndJobOnce(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[811] = blockedReport(t, "GO-2099-0001")
	s.trunkRuns = []int64{901}
	s.trunkJobs[901] = []fakeJob{{Id: 9011, Name: scanName, Conclusion: "success"}}
	s.files[81] = []string{"go.mod"}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 81, HeadOid: "aaa", Checks: []Check{failedScan(811)}}}}
	reader := MakeReader()
	first := reader.Assess(context.Background(), s.gh, in)
	calls := len(s.calls)
	second := reader.Assess(context.Background(), s.gh, in)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("the same inputs gave %+v then %+v", first, second)
	}
	// Only the trunk's list of runs is read again, after its short life: here nothing is, the clock did not move.
	if len(s.calls) != calls {
		t.Fatalf("a second assessment of the same run called gh again: %v", s.calls[calls:])
	}
	if s.count("run download 811") != 1 || s.count("api") != 1 {
		t.Fatalf("calls = %v", s.calls)
	}
}

func TestAssessRetriesWhatCouldNotBeReadOnlyAfterItsShortLife(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.trunkRuns = []int64{}
	now := time.Unix(1_800_000_000, 0)
	reader := MakeReader()
	reader.now = func() time.Time { return now }
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 91, HeadOid: "a", Checks: []Check{failedScan(911)}}}}
	result := reader.Assess(context.Background(), s.gh, in)
	if len(result.Blocks) != 0 || len(result.Unread) != 1 || result.Unread[0].Pr != 91 || result.Unread[0].Cause != CauseReportUnreadable {
		t.Fatalf("a scan that cannot be read says so: %+v", result)
	}
	calls := len(s.calls)
	reader.Assess(context.Background(), s.gh, in)
	if len(s.calls) != calls {
		t.Fatal("a failure is not retried at once")
	}
	s.reports[911] = blockedReport(t, "GO-2099-0001")
	now = now.Add(errorTtl + 1)
	s.files[91] = []string{"go.mod"}
	if again := reader.Assess(context.Background(), s.gh, in); len(again.Blocks) != 1 {
		t.Fatalf("once the report is there, the next read finds it: %+v", again)
	}
}

func TestAssessSaysWhyAScannerThatCouldNotRunHasNoAdvisory(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[1011] = fixture(t, "moltenterm-input-failure.json")
	s.trunkRuns = []int64{}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 101, HeadOid: "a", Checks: []Check{failedScan(1011)}}}}
	result := MakeReader().Assess(context.Background(), s.gh, in)
	if len(result.Blocks) != 0 || len(result.Unread) != 1 || result.Unread[0].Cause != CauseScannerInputFailure {
		t.Fatalf("result = %+v", result)
	}
	if s.count("run view") != 0 {
		t.Fatalf("the report said why: the log is not searched for ids, calls %v", s.calls)
	}
}

func TestAssessLeavesNoFileBehind(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[1111] = blockedReport(t, "GO-2099-0001")
	s.trunkRuns = []int64{}
	s.files[111] = []string{"go.mod"}
	var downloaded []string
	gh := func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		for _, arg := range args {
			if strings.HasPrefix(arg, "--dir=") {
				downloaded = append(downloaded, strings.TrimPrefix(arg, "--dir="))
			}
		}
		return s.gh(ctx, dir, args...)
	}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 111, HeadOid: "a", Checks: []Check{failedScan(1111)}}}}
	MakeReader().Assess(context.Background(), gh, in)
	if len(downloaded) != 1 {
		t.Fatalf("downloaded = %v", downloaded)
	}
	if _, err := os.Stat(downloaded[0]); !os.IsNotExist(err) {
		t.Fatalf("the downloaded artifact is removed after it is read: %v", err)
	}
}

func TestInputKeyFollowsWhatWouldBeRead(t *testing.T) {
	t.Parallel()
	base := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 1, HeadOid: "a", Checks: []Check{failedScan(5)}}}}
	key := base.Key()
	if key == "" || key != base.Key() {
		t.Fatalf("key = %q", key)
	}
	rerun := base
	rerun.Prs = []PrInput{{Number: 1, HeadOid: "a", Checks: []Check{failedScan(6)}}}
	pushed := base
	pushed.Prs = []PrInput{{Number: 1, HeadOid: "b", Checks: []Check{failedScan(5)}}}
	answered := base
	answered.Policy = Policy{Declaration: base.Policy.Declaration, Confirmed: []string{"Another scan"}}
	for name, other := range map[string]Input{"a new run": rerun, "a push": pushed, "a new answer": answered} {
		if other.Key() == key {
			t.Errorf("%s does not change the key", name)
		}
	}
}

func TestAssessGivesACodeForEachWayAScanCouldNotBeRead(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.trunkRuns = []int64{}
	noJob := failedScan(122)
	noJob.JobId = 0
	noRun := Check{Name: scanName, Workflow: "CI", Failed: true}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{
		// a report that is not there and a log that is not there either: the report is what was asked for
		{Number: 121, HeadOid: "a", Checks: []Check{failedScan(121)}},
		{Number: 122, HeadOid: "b", Checks: []Check{noJob}},
		{Number: 123, HeadOid: "c", Checks: []Check{noRun}},
	}}
	causes := func(result Result) map[int]string {
		got := map[int]string{}
		for _, unread := range result.Unread {
			got[unread.Pr] = unread.Cause
		}
		return got
	}
	want := map[int]string{121: CauseReportUnreadable, 122: CauseNoJob, 123: CauseNoJob}
	if got := causes(MakeReader().Assess(context.Background(), s.gh, in)); !reflect.DeepEqual(got, want) {
		t.Fatalf("causes = %v, want %v", got, want)
	}

	// With no declaration the log is the only source: a log that names nothing, and a log gh could not give.
	s.logs[1241] = "nothing of interest\n"
	log := Input{Dir: "/p", Trunk: "develop", Policy: Policy{Confirmed: []string{scanName}}, Prs: []PrInput{
		{Number: 124, HeadOid: "a", Checks: []Check{failedScan(124)}},
		{Number: 125, HeadOid: "b", Checks: []Check{{Name: scanName, Workflow: "CI", Failed: true, RunId: 125, JobId: 9999}}},
	}}
	want = map[int]string{124: CauseNoAdvisory, 125: CauseLogUnreadable}
	if got := causes(MakeReader().Assess(context.Background(), s.gh, log)); !reflect.DeepEqual(got, want) {
		t.Fatalf("causes = %v, want %v", got, want)
	}
}

func TestReadReportAsksForTheArtifactByNameOrByPattern(t *testing.T) {
	t.Parallel()
	for artifact, flag := range map[string]string{"dependency-security-1-1": "--name=", "dependency-security-*": "--pattern="} {
		s := makeScenario(t)
		s.reports[7] = blockedReport(t, "GO-2099-0001")
		reading, err := readReport(context.Background(), s.gh, "/p", &ReportSpec{Artifact: artifact, Format: FormatMoltenterm}, 7)
		if err != nil || len(reading.Advisories) != 1 {
			t.Fatalf("%s: %+v, %v", artifact, reading, err)
		}
		if len(s.calls) != 1 || !strings.Contains(s.calls[0], flag+artifact) {
			t.Fatalf("%s: calls = %v", artifact, s.calls)
		}
	}
}

func TestAssessATrunkWhoseScanCouldNotRunSaysNothingOfThePrs(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.reports[1311] = blockedReport(t, "GO-2099-0001")
	s.trunkRuns = []int64{901}
	s.trunkJobs[901] = []fakeJob{{Id: 9011, Name: scanName, Conclusion: "failure"}}
	s.reports[901] = fixture(t, "moltenterm-input-failure.json")
	s.files[131] = []string{"go.mod"}
	in := Input{Dir: "/p", Trunk: "develop", Policy: declaredPolicy(), Prs: []PrInput{{Number: 131, HeadOid: "a", Checks: []Check{failedScan(1311)}}}}
	block := MakeReader().Assess(context.Background(), s.gh, in).Blocks[0]
	if block.TrunkFailing || block.Shared {
		t.Fatalf("the trunk's scan failed for no advisory: %+v", block)
	}
}

func TestAssessOffersEachPrOnce(t *testing.T) {
	t.Parallel()
	s := makeScenario(t)
	s.logs[1411] = "##[error]GO-2099-0001\n"
	s.logs[1412] = "##[error]GO-2099-0001\n"
	in := Input{Dir: "/p", Trunk: "develop", Prs: []PrInput{{Number: 141, HeadOid: "a", Checks: []Check{
		{Name: "Security audit", Workflow: "Audit", Failed: true, RunId: 141, JobId: 1411},
		{Name: "Security audit", Workflow: "Nightly", Failed: true, RunId: 142, JobId: 1412},
	}}}}
	offers := MakeReader().Assess(context.Background(), s.gh, in).Offers
	if len(offers) != 1 || !reflect.DeepEqual(offers[0].Prs, []int{141}) {
		t.Fatalf("offers = %+v", offers)
	}
}

func TestFindReportFileReadsRegularFilesOnly(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.json")
	if err := os.WriteFile(outside, []byte(`{"secret":true}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "artifact", "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "artifact", "report.json")); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if _, err := findReportFile(root, "report.json"); err == nil {
		t.Fatal("a link in an artifact is never followed")
	}
	if err := os.WriteFile(filepath.Join(root, "artifact", "nested", "report.json"), []byte(`{"ok":1}`), 0644); err != nil {
		t.Fatal(err)
	}
	data, err := findReportFile(root, "report.json")
	if err != nil || string(data) != `{"ok":1}` {
		t.Fatalf("data = %q, %v", data, err)
	}
	if _, err := findReportFile(root, "nested/report.json"); err != nil {
		t.Fatalf("a file named with its folder is found: %v", err)
	}
	if _, err := findReportFile(root, "missing.json"); err == nil {
		t.Fatal("a file the artifact does not hold is an error")
	}
}
