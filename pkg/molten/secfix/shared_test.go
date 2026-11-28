// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"path/filepath"
	"reflect"
	"testing"
)

func advisoriesOf(ids ...string) []Advisory {
	list := make([]Advisory, 0, len(ids))
	for _, id := range ids {
		list = append(list, Advisory{Id: id})
	}
	return list
}

func factsOf(number int, files []string, ids ...string) prFacts {
	return prFacts{Number: number, Checks: []string{"Scan"}, Origin: OriginDeclared, Source: SourceReport, Advisories: advisoriesOf(ids...), Files: files, FilesKnown: files != nil}
}

func TestBuildBlocksGroupsPrsThatShareAnAdvisory(t *testing.T) {
	t.Parallel()
	blocks := buildBlocks([]prFacts{
		factsOf(1, []string{"go.mod"}, "GO-1", "GO-2"),
		factsOf(2, []string{"go.mod"}, "GO-2"),
		factsOf(3, []string{"go.mod"}, "GO-9"),
		factsOf(4, []string{"go.mod"}, "GO-2", "GO-3"),
	}, trunkFacts{}, nil)
	if len(blocks) != 2 {
		t.Fatalf("blocks = %+v", blocks)
	}
	first, second := blocks[0], blocks[1]
	if got := Ids(first.Advisories); !reflect.DeepEqual(got, []string{"GO-1", "GO-2", "GO-3"}) {
		t.Fatalf("the first block's set = %v", got)
	}
	numbers := []int{}
	for _, pr := range first.Prs {
		numbers = append(numbers, pr.Number)
		if !pr.Shared || !reflect.DeepEqual(pr.Reasons, []string{ReasonPrs}) {
			t.Errorf("#%d: %+v", pr.Number, pr)
		}
	}
	if !reflect.DeepEqual(numbers, []int{1, 2, 4}) || !first.Shared {
		t.Fatalf("the first block holds %v, shared %v", numbers, first.Shared)
	}
	if second.Shared || len(second.Prs) != 1 || second.Prs[0].Number != 3 || second.Fingerprint != Fingerprint([]string{"GO-9"}) {
		t.Fatalf("a pull request alone on its advisory that changes go.mod caused it: %+v", second)
	}
	if first.Fingerprint == second.Fingerprint {
		t.Fatal("two sets, one key")
	}
}

func TestBuildBlocksWithATrunkWhoseAdvisoriesAreUnreadable(t *testing.T) {
	t.Parallel()
	blocks := buildBlocks([]prFacts{factsOf(1, []string{"go.mod"}, "GO-1")}, trunkFacts{Failing: true, Run: 7}, nil)
	if len(blocks) != 1 || !blocks[0].Shared || !blocks[0].TrunkFailing || blocks[0].TrunkRun != 7 {
		t.Fatalf("a scan that fails on the trunk with no way to tell its advisories is the trunk's failure: %+v", blocks)
	}
	if got := blocks[0].Prs[0].Reasons; !reflect.DeepEqual(got, []string{ReasonTrunk}) {
		t.Fatalf("reasons = %v", got)
	}
}

func TestBuildBlocksTrunkAdvisoriesJoinTheSet(t *testing.T) {
	t.Parallel()
	blocks := buildBlocks([]prFacts{factsOf(1, []string{"go.mod"}, "GO-1")},
		trunkFacts{Failing: true, Run: 7, Advisories: advisoriesOf("GO-1", "GO-5")}, nil)
	if len(blocks) != 1 {
		t.Fatalf("blocks = %+v", blocks)
	}
	// Fixing the trunk's whole set is what unblocks the pull request, so the set is the trunk's.
	if got := Ids(blocks[0].Advisories); !reflect.DeepEqual(got, []string{"GO-1", "GO-5"}) {
		t.Fatalf("the block's set = %v", got)
	}
	if blocks[0].Fingerprint != Fingerprint([]string{"GO-5", "GO-1"}) {
		t.Fatal("the key follows the set")
	}
}

func TestBuildBlocksAFailingTrunkOfAnotherSetStaysApart(t *testing.T) {
	t.Parallel()
	blocks := buildBlocks([]prFacts{factsOf(1, []string{"go.mod"}, "GO-1")},
		trunkFacts{Failing: true, Run: 7, Advisories: advisoriesOf("GO-5")}, nil)
	if len(blocks) != 1 || blocks[0].TrunkFailing || blocks[0].Shared {
		t.Fatalf("blocks = %+v", blocks)
	}
}

func TestBuildBlocksDependencyFilesOfTheProject(t *testing.T) {
	t.Parallel()
	own := factsOf(1, []string{"security/dependencies.json"}, "GO-1")
	if blocks := buildBlocks([]prFacts{own}, trunkFacts{}, []string{"security/dependencies.json"}); blocks[0].Shared {
		t.Fatalf("a change of the project's own policy file is a dependency change: %+v", blocks[0])
	}
	if blocks := buildBlocks([]prFacts{own}, trunkFacts{}, nil); !blocks[0].Shared {
		t.Fatalf("without the declaration it is not one: %+v", blocks[0])
	}
}

func TestBuildBlocksOriginAndSourceFollowTheWeakest(t *testing.T) {
	t.Parallel()
	declared := factsOf(1, []string{"go.mod"}, "GO-1")
	confirmed := factsOf(2, []string{"go.mod"}, "GO-1")
	confirmed.Origin, confirmed.Source = OriginConfirmed, SourceLog
	block := buildBlocks([]prFacts{declared, confirmed}, trunkFacts{}, nil)[0]
	if block.Origin != OriginConfirmed || block.Source != SourceLog {
		t.Fatalf("block = %+v", block)
	}
}

func TestIsDependencyFile(t *testing.T) {
	t.Parallel()
	for file, want := range map[string]bool{
		"go.mod":                       true,
		"./go.sum":                     true,
		"tsunami/go.mod":               true,
		"package.json":                 true,
		"docs/package-lock.json":       true,
		"Cargo.lock":                   true,
		"backend/requirements-dev.txt": true,
		"requirements.txt":             true,
		"pnpm-lock.yaml":               true,
		"security/dependencies.json":   true,
		"vendor/policy/allow.json":     true,
		"main.go":                      false,
		"docs/go.mod.md":               false,
		"notes/requirements.md":        false,
		"src/package.json.ts":          false,
	} {
		if got := IsDependencyFile(file, []string{"security/dependencies.json", "allow.json"}); got != want {
			t.Errorf("IsDependencyFile(%q) = %v, want %v", file, got, want)
		}
	}
	if IsDependencyFile("security/dependencies.json", nil) {
		t.Error("a project's own file counts only when it says so")
	}
}

func TestRestrictDropsWhatIsNoLongerListed(t *testing.T) {
	t.Parallel()
	result := Result{
		Blocks: []Block{
			{Fingerprint: "a", Shared: true, Prs: []BlockPr{{Number: 1, Shared: true}, {Number: 2, Shared: false}}},
			{Fingerprint: "b", Shared: true, Prs: []BlockPr{{Number: 3, Shared: true}}},
		},
		Offers: []Offer{{Check: "x", Prs: []int{2, 3}}, {Check: "y", Prs: []int{3}}},
		Unread: []Unread{{Pr: 2}, {Pr: 3}},
	}
	kept := result.Restrict(map[int]bool{2: true})
	if len(kept.Blocks) != 1 || kept.Blocks[0].Fingerprint != "a" || kept.Blocks[0].Shared || len(kept.Blocks[0].Prs) != 1 {
		t.Fatalf("blocks = %+v", kept.Blocks)
	}
	if len(kept.Offers) != 1 || !reflect.DeepEqual(kept.Offers[0].Prs, []int{2}) || len(kept.Unread) != 1 || kept.Unread[0].Pr != 2 {
		t.Fatalf("kept = %+v", kept)
	}
	if empty := result.Restrict(nil); len(empty.Blocks)+len(empty.Offers)+len(empty.Unread) != 0 || empty.Blocks == nil {
		t.Fatalf("nothing listed, nothing kept (as empty lists, never null): %+v", empty)
	}
}

func TestStoreKeepsTheDevelopersAnswersPerProject(t *testing.T) {
	t.Parallel()
	file := filepath.Join(t.TempDir(), "data", "security-scans.json")
	store := MakeStore(file)
	if confirmed, dismissed := store.Get("/p"); confirmed != nil || dismissed != nil {
		t.Fatal("nothing is answered yet")
	}
	if err := store.Answer("/p", "Security  audit", AnswerConfirm); err != nil {
		t.Fatal(err)
	}
	if err := store.Answer("/p", "Trivy", AnswerDismiss); err != nil {
		t.Fatal(err)
	}
	if err := store.Answer("/other/", "Other", AnswerConfirm); err != nil {
		t.Fatal(err)
	}
	reopened := MakeStore(file)
	confirmed, dismissed := reopened.Get("/p/")
	if !reflect.DeepEqual(confirmed, []string{"Security audit"}) || !reflect.DeepEqual(dismissed, []string{"Trivy"}) {
		t.Fatalf("confirmed %v, dismissed %v", confirmed, dismissed)
	}
	if other, _ := reopened.Get("/other"); !reflect.DeepEqual(other, []string{"Other"}) {
		t.Fatalf("another project keeps its own answers: %v", other)
	}
	if err := reopened.Answer("/p", "security audit", AnswerDismiss); err != nil {
		t.Fatal(err)
	}
	confirmed, dismissed = reopened.Get("/p")
	if len(confirmed) != 0 || !reflect.DeepEqual(dismissed, []string{"Trivy", "security audit"}) {
		t.Fatalf("a new answer replaces the earlier one for the same check: %v %v", confirmed, dismissed)
	}
	if err := reopened.Answer("/p", "Trivy", AnswerReset); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Answer("/p", "security audit", AnswerReset); err != nil {
		t.Fatal(err)
	}
	if confirmed, dismissed = reopened.Get("/p"); len(confirmed)+len(dismissed) != 0 {
		t.Fatalf("withdrawn answers are gone: %v %v", confirmed, dismissed)
	}
}

func TestStoreRefusesWhatItCannotKeep(t *testing.T) {
	t.Parallel()
	store := MakeStore(filepath.Join(t.TempDir(), "scans.json"))
	for name, call := range map[string]func() error{
		"no name":     func() error { return store.Answer("/p", "  ", AnswerConfirm) },
		"a wildcard":  func() error { return store.Answer("/p", "Security *", AnswerConfirm) },
		"a long name": func() error { return store.Answer("/p", string(make([]byte, 300)), AnswerConfirm) },
		"an answer":   func() error { return store.Answer("/p", "Security audit", "maybe") },
		"no store":    func() error { var none *Store; return none.Answer("/p", "Security audit", AnswerConfirm) },
	} {
		if call() == nil {
			t.Errorf("%s: kept", name)
		}
	}
	var none *Store
	if confirmed, dismissed := none.Get("/p"); confirmed != nil || dismissed != nil {
		t.Fatal("no store, no answer")
	}
}
