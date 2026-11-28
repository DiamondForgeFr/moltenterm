// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

const securityProject = `{"schema":1,"name":"app","ci":{"security":{"checks":["Dependency security / Scan dependencies"],"report":{"artifact":"dependency-security-*","file":"report.json","format":"moltenterm"},"dependencyfiles":["security/dependencies.json"]}}}`

const securityReport = `{"schema":1,"status":"blocked-policy","findings":[{"ecosystem":"go","id":"GO-2099-0001","package":"example.com/fake/lib","version":"v1.2.0","fixedVersion":"1.2.4","severity":"high","title":"Fake advisory","verdict":"blocked"}]}`

func scanRollup(run int, job int, conclusion string) string {
	return `{"name":"Dependency security / Scan dependencies","workflowName":"CI","status":"COMPLETED","conclusion":"` + conclusion +
		`","detailsUrl":"https://github.com/acme/app/actions/runs/` + itoa(run) + `/job/` + itoa(job) + `"}`
}

func itoa(n int) string {
	data, _ := json.Marshal(n)
	return string(data)
}

func securityPrs(scan20 string, scan21 string) string {
	return `[
 {"number":20,"title":"first","headRefName":"feature/20-first","baseRefName":"develop","headRefOid":"aaa","isDraft":false,"updatedAt":"2026-10-12T10:00:00Z","mergeStateStatus":"BLOCKED","statusCheckRollup":[` + scan20 + `]},
 {"number":21,"title":"second","headRefName":"fix/21-second","baseRefName":"develop","headRefOid":"bbb","isDraft":false,"updatedAt":"2026-10-11T10:00:00Z","mergeStateStatus":"BLOCKED","statusCheckRollup":[` + scan21 + `]},
 {"number":22,"title":"unrelated","headRefName":"feature/22-other","baseRefName":"develop","headRefOid":"ccc","isDraft":true,"updatedAt":"2026-10-10T10:00:00Z","statusCheckRollup":[{"name":"Quick checks","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/acme/app/actions/runs/700/job/7001"}]}
]`
}

type securityGh struct {
	calls atomic.Int32
	// Runs whose artifact holds the report.
	reports map[string]string
}

func (g *securityGh) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name != "gh" {
		return nil, errors.New("only gh here")
	}
	g.calls.Add(1)
	joined := strings.Join(args, " ")
	switch {
	case args[0] == "run" && args[1] == "download":
		report, ok := g.reports[args[2]]
		if !ok {
			return nil, errors.New("no valid artifacts found to download")
		}
		for _, arg := range args {
			if target, ok := strings.CutPrefix(arg, "--dir="); ok {
				folder := filepath.Join(target, "dependency-security-"+args[2]+"-1")
				if err := os.MkdirAll(folder, 0755); err != nil {
					return nil, err
				}
				return nil, os.WriteFile(filepath.Join(folder, "report.json"), []byte(report), 0644)
			}
		}
	case args[0] == "run" && args[1] == "list":
		return []byte(`[]`), nil
	case args[0] == "api" && strings.Contains(joined, "/pulls/20/files"):
		return []byte("go.mod\npkg/a.go\n"), nil
	case args[0] == "api" && strings.Contains(joined, "/pulls/21/files"):
		return []byte("docs/readme.md\n"), nil
	}
	return nil, errors.New("unexpected gh call: " + joined)
}

func securityReviews(t *testing.T, gh *securityGh) (*Reviews, string) {
	t.Helper()
	dir := reviewsProject(t, reviewsSfManifest)
	if err := os.MkdirAll(filepath.Join(dir, ".molten"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(securityProject), 0644); err != nil {
		t.Fatal(err)
	}
	reviews := MakeReviews(nil, gh.run, nil)
	reviews.securityStore = secfix.MakeStore(filepath.Join(t.TempDir(), SecurityScansFileName))
	return reviews, dir
}

// assessNow runs the assessment an ask would start, to its end.
func assessNow(t *testing.T, reviews *Reviews, answer *ReviewsAnswer) {
	t.Helper()
	in, key := reviews.applySecurity(answer)
	if !reviews.prepareSecurity(answer.Dir, key, false) {
		t.Fatalf("an assessment was due for key %q", key)
	}
	reviews.readSecurity(in, ghRepoRef(answer.Repo, answer.Url))
}

func TestReviewsSecurityBlocksFollowTheFailedScans(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{"500": securityReport, "501": securityReport}}
	reviews, dir := securityReviews(t, gh)
	prs := securityPrs(scanRollup(500, 5001, "FAILURE"), scanRollup(501, 5011, "FAILURE"))
	first := BuildReviews(reviewsSnapshot(dir, prs))
	if _, ok := reviews.SecurityResult(dir); ok {
		t.Fatal("nothing was assessed yet")
	}
	assessNow(t, reviews, &first)
	if result, ok := reviews.SecurityResult(dir); !ok || len(result.Blocks) != 1 {
		t.Fatalf("the work that follows a shared block reads what was found: %+v, %v", result, ok)
	}

	again := BuildReviews(reviewsSnapshot(dir, prs))
	reviews.applySecurity(&again)
	if len(again.SecurityBlocks) != 1 || len(again.SecurityOffers) != 0 || len(again.SecurityUnread) != 0 {
		t.Fatalf("answer = %+v", again)
	}
	block := again.SecurityBlocks[0]
	if block.Fingerprint != secfix.Fingerprint([]string{"GO-2099-0001"}) || !block.Shared || block.Origin != secfix.OriginDeclared || block.Source != secfix.SourceReport {
		t.Fatalf("block = %+v", block)
	}
	if len(block.Prs) != 2 || block.Prs[0].Number != 20 || block.Prs[1].Number != 21 {
		t.Fatalf("prs = %+v", block.Prs)
	}
	// #20 changes go.mod and shares the advisory with #21; #21 changes only documents.
	if !reflect.DeepEqual(block.Prs[0].Reasons, []string{secfix.ReasonPrs}) || !reflect.DeepEqual(block.Prs[1].Reasons, []string{secfix.ReasonPrs, secfix.ReasonNoDependencyChange}) {
		t.Fatalf("reasons = %+v", block.Prs)
	}
	byNumber := map[int]string{}
	for _, pr := range append(append([]ReviewPr{}, again.Ready...), again.Drafts...) {
		byNumber[pr.Number] = pr.SecurityBlock
	}
	if byNumber[20] != block.Fingerprint || byNumber[21] != block.Fingerprint || byNumber[22] != "" {
		t.Fatalf("each blocked pull request names its block: %v", byNumber)
	}
	data, err := json.Marshal(again)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"securityblocks"`, `"securityblock":"` + block.Fingerprint + `"`, `"fingerprint"`} {
		if !strings.Contains(string(data), field) {
			t.Errorf("the wire answer lacks %s", field)
		}
	}
	if strings.Contains(string(data), "securityoffers") || strings.Contains(string(data), "securityunread") {
		t.Errorf("empty lists stay off the wire: %s", data)
	}
}

func TestReviewsSecurityReadsOnceWhileTheChecksStayTheSame(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{"500": securityReport, "501": securityReport}}
	reviews, dir := securityReviews(t, gh)
	now := time.Unix(1_800_000_000, 0)
	reviews.now = func() time.Time { return now }
	prs := securityPrs(scanRollup(500, 5001, "FAILURE"), scanRollup(501, 5011, "FAILURE"))
	answer := BuildReviews(reviewsSnapshot(dir, prs))
	assessNow(t, reviews, &answer)
	calls := gh.calls.Load()

	same := BuildReviews(reviewsSnapshot(dir, prs))
	in, key := reviews.applySecurity(&same)
	now = now.Add(30 * time.Second)
	if reviews.prepareSecurity(dir, key, false) {
		t.Fatal("the same failed checks within the minutes: the answer stands")
	}
	if !reviews.prepareSecurity(dir, key, true) {
		t.Fatal("a forced refresh reads again")
	}
	reviews.readSecurity(in, "acme/app")
	if gh.calls.Load() != calls {
		t.Fatalf("what a run's report said is kept by run and head, yet gh calls went from %d to %d", calls, gh.calls.Load())
	}

	now = now.Add(securityMaxAge)
	if !reviews.prepareSecurity(dir, key, false) {
		t.Fatal("an old answer is read again: the trunk may have turned")
	}
	reviews.storeSecurity(dir, secfix.Result{}, false)

	rerun := BuildReviews(reviewsSnapshot(dir, securityPrs(scanRollup(500, 5002, "FAILURE"), scanRollup(501, 5011, "FAILURE"))))
	_, rerunKey := reviews.applySecurity(&rerun)
	if rerunKey == key {
		t.Fatal("a rerun is another job: the key changes")
	}
	now = now.Add(time.Minute)
	if !reviews.prepareSecurity(dir, rerunKey, false) {
		t.Fatal("a new job is read at once")
	}
}

func TestReviewsSecurityClearsWhatTheChecksNoLongerCall(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{"500": securityReport, "501": securityReport}}
	reviews, dir := securityReviews(t, gh)
	failing := securityPrs(scanRollup(500, 5001, "FAILURE"), scanRollup(501, 5011, "FAILURE"))
	answer := BuildReviews(reviewsSnapshot(dir, failing))
	assessNow(t, reviews, &answer)

	fixed := securityPrs(scanRollup(500, 5001, "SUCCESS"), scanRollup(501, 5011, "SUCCESS"))
	green := BuildReviews(reviewsSnapshot(dir, fixed))
	in, key := reviews.applySecurity(&green)
	// No failed check could be the scan; the project names its scan, so its trunk is still watched (FR-REV-036 AC16).
	if in.HasFailedScan() || len(in.Prs) == 0 || key == "" {
		t.Fatalf("no failed check could be the scan, and the trunk is watched: key %q", key)
	}
	if len(green.SecurityBlocks) != 0 || green.Ready[0].SecurityBlock != "" {
		t.Fatalf("a scan that passes again leaves no block: %+v", green.SecurityBlocks)
	}
	reviews.prepareSecurity(dir, key, false)
	if _, ok := reviews.SecurityResult(dir); ok {
		t.Fatal("what was found is no longer there to follow")
	}
	back := BuildReviews(reviewsSnapshot(dir, failing))
	reviews.applySecurity(&back)
	if len(back.SecurityBlocks) != 0 {
		t.Fatalf("what was found is dropped with the failure: %+v", back.SecurityBlocks)
	}
}

func TestReviewsSecurityDropsPrsThatLeftTheList(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{"500": securityReport, "501": securityReport}}
	reviews, dir := securityReviews(t, gh)
	prs := securityPrs(scanRollup(500, 5001, "FAILURE"), scanRollup(501, 5011, "FAILURE"))
	answer := BuildReviews(reviewsSnapshot(dir, prs))
	assessNow(t, reviews, &answer)

	var remaining []json.RawMessage
	var all []json.RawMessage
	if err := json.Unmarshal([]byte(prs), &all); err != nil {
		t.Fatal(err)
	}
	remaining = append(remaining, all[0], all[2])
	data, _ := json.Marshal(remaining)
	merged := BuildReviews(reviewsSnapshot(dir, string(data)))
	reviews.applySecurity(&merged)
	if len(merged.SecurityBlocks) != 1 || len(merged.SecurityBlocks[0].Prs) != 1 || merged.SecurityBlocks[0].Prs[0].Number != 20 {
		t.Fatalf("a merged pull request leaves its block at once: %+v", merged.SecurityBlocks)
	}
}

func TestReviewsSecurityOffersAGuessAndKeepsTheAnswerOutsideTheRepository(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{}}
	dir := reviewsProject(t, reviewsSfManifest)
	logs := map[string]string{"5001": "##[error]GO-2099-0001 example.com/fake/lib@v1.2.0\n"}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if args[0] == "run" && args[1] == "view" {
			for i, arg := range args {
				if arg == "--job" {
					if log, ok := logs[args[i+1]]; ok {
						return []byte(log), nil
					}
				}
			}
		}
		return gh.run(ctx, d, name, args...)
	}
	reviews := MakeReviews(nil, run, nil)
	store := secfix.MakeStore(filepath.Join(t.TempDir(), SecurityScansFileName))
	reviews.securityStore = store
	audit := `{"name":"Security audit","workflowName":"Audit","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/acme/app/actions/runs/500/job/5001"}`
	prs := securityPrs(audit, scanRollup(501, 5011, "SUCCESS"))
	answer := BuildReviews(reviewsSnapshot(dir, prs))
	assessNow(t, reviews, &answer)

	offered := BuildReviews(reviewsSnapshot(dir, prs))
	reviews.applySecurity(&offered)
	if len(offered.SecurityBlocks) != 0 || len(offered.SecurityOffers) != 1 || offered.SecurityOffers[0].Check != "Security audit" ||
		!reflect.DeepEqual(offered.SecurityOffers[0].Ids, []string{"GO-2099-0001"}) || !reflect.DeepEqual(offered.SecurityOffers[0].Prs, []int{20}) {
		t.Fatalf("a check that only looks like the scan is offered, not acted on: blocks %+v offers %+v", offered.SecurityBlocks, offered.SecurityOffers)
	}
	if offered.Ready[0].SecurityBlock != "" {
		t.Fatal("an offer puts no pull request in a block")
	}

	if err := store.Answer(dir, "Security audit", secfix.AnswerConfirm); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != ".saasfoundry.json" {
			t.Fatalf("the answer is never written in the project, yet it holds %s", entry.Name())
		}
	}
	confirmed := BuildReviews(reviewsSnapshot(dir, prs))
	assessNow(t, reviews, &confirmed)
	acted := BuildReviews(reviewsSnapshot(dir, prs))
	reviews.applySecurity(&acted)
	if len(acted.SecurityBlocks) != 1 || acted.SecurityBlocks[0].Origin != secfix.OriginConfirmed || len(acted.SecurityOffers) != 0 {
		t.Fatalf("once confirmed, the check is the project's scan: %+v", acted)
	}
}

func TestReviewsSecurityReadsNothingWithoutAFailedScan(t *testing.T) {
	t.Parallel()
	gh := &securityGh{reports: map[string]string{}}
	reviews, dir := securityReviews(t, gh)
	// A project that names no scan has nothing to read while no check fails; one that does has its trunk watched.
	if err := os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"app"}`), 0644); err != nil {
		t.Fatal(err)
	}
	green := BuildReviews(reviewsSnapshot(dir, securityPrs(scanRollup(500, 5001, "SUCCESS"), scanRollup(501, 5011, "SUCCESS"))))
	in, key := reviews.applySecurity(&green)
	reviews.startSecurity(green, in, key, true)
	if key != "" || gh.calls.Load() != 0 {
		t.Fatalf("key %q, %d gh calls", key, gh.calls.Load())
	}
	noGithub := BuildReviews(Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateNoGh}})
	if _, ok := reviews.securityInput(noGithub); ok {
		t.Fatal("without GitHub nothing is assessed")
	}
}

func TestReadSecurityDeclaration(t *testing.T) {
	t.Parallel()
	write := func(content string) string {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, ".molten"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	if decl := readSecurityDeclaration(write(securityProject)); decl == nil || decl.Report == nil || decl.Checks[0] != "Dependency security / Scan dependencies" {
		t.Fatalf("declaration = %+v", decl)
	}
	for name, content := range map[string]string{
		"no ci":             `{"schema":1,"name":"app"}`,
		"no security":       `{"schema":1,"name":"app","ci":{"jobs":[]}}`,
		"a bad format":      `{"schema":1,"name":"app","ci":{"security":{"checks":["x"],"report":{"artifact":"a","format":"sarif"}}}}`,
		"no check":          `{"schema":1,"name":"app","ci":{"security":{"checks":[]}}}`,
		"not json":          `{`,
		"a climbing report": `{"schema":1,"name":"app","ci":{"security":{"checks":["x"],"report":{"artifact":"a","file":"../x.json"}}}}`,
	} {
		if decl := readSecurityDeclaration(write(content)); decl != nil {
			t.Errorf("%s: read %+v", name, decl)
		}
	}
	if readSecurityDeclaration(t.TempDir()) != nil {
		t.Error("a project with no pipeline declares nothing")
	}
}

func TestAnswerSecurityScanKeepsTheAnswer(t *testing.T) {
	t.Parallel()
	dir := reviewsProject(t, reviewsSfManifest)
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		return nil, errors.New("no gh here")
	}
	collector := testCollector(t, "", run, nil)
	reviews := MakeReviews(collector, run, nil)
	store := secfix.MakeStore(filepath.Join(t.TempDir(), SecurityScansFileName))
	reviews.securityStore = store
	if _, err := reviews.AnswerSecurityScan(ReviewsSecurityRequest{Dir: dir, Check: "Security audit", Answer: "maybe"}); err == nil {
		t.Fatal("an answer that is none of the three is refused")
	}
	if _, err := reviews.AnswerSecurityScan(ReviewsSecurityRequest{Dir: dir, Check: " ", Answer: secfix.AnswerConfirm}); err == nil {
		t.Fatal("a check with no name is refused")
	}
	if _, err := reviews.AnswerSecurityScan(ReviewsSecurityRequest{Dir: "relative/folder", Check: "Security audit", Answer: secfix.AnswerConfirm}); err == nil {
		t.Fatal("a project folder must be an absolute path")
	}
	if _, err := reviews.AnswerSecurityScan(ReviewsSecurityRequest{Dir: dir, Check: "Security audit", Answer: secfix.AnswerConfirm}); err != nil {
		t.Fatal(err)
	}
	if confirmed, _ := store.Get(dir); !reflect.DeepEqual(confirmed, []string{"Security audit"}) {
		t.Fatalf("confirmed = %v", confirmed)
	}
}

func TestReviewsSecurityCommandOnlyFromAWindow(t *testing.T) {
	t.Parallel()
	if _, ok := windowCommands[ReviewsSecurityCommand]; !ok {
		t.Fatal("which check is the scan is the developer's answer: an agent in a terminal never gives it")
	}
}
