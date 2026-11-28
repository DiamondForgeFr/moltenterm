// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// PrInput is a listed pull request and its checks as GitHub shows them.
type PrInput struct {
	Number  int
	HeadOid string
	Checks  []Check
}

// Input is what one assessment looks at: a project's listed pull requests, its trunk and what it knows of its scan.
type Input struct {
	Dir    string
	Trunk  string
	Policy Policy
	Prs    []PrInput
}

// Key changes when something the assessment would read changes: a failed check that could be the scan, on a head, run
// and job, or the policy's answers. It is empty when no failed check could be one: nothing is read then, so a project
// whose checks are green or unrelated costs no gh call.
func (in Input) Key() string {
	var lines []string
	for _, pr := range in.Prs {
		for _, check := range pr.Checks {
			if in.Policy.Classify(check) != ClassNone {
				lines = append(lines, fmt.Sprintf("%d@%s %s/%s %d:%d", pr.Number, pr.HeadOid, check.Workflow, check.Name, check.RunId, check.JobId))
			}
		}
	}
	if len(lines) == 0 {
		return ""
	}
	sort.Strings(lines)
	lines = append(lines, "trunk "+in.Trunk, "policy "+in.Policy.digest())
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:])
}

func (p Policy) digest() string {
	var parts []string
	if p.Declaration != nil {
		parts = append(parts, "declared:"+strings.Join(p.Declaration.Checks, "\x1f"))
		parts = append(parts, "files:"+strings.Join(p.Declaration.DependencyFiles, "\x1f"))
		if p.Declaration.Report != nil {
			parts = append(parts, "report:"+reportKey(p.Declaration))
		}
	}
	parts = append(parts, "confirmed:"+strings.Join(p.Confirmed, "\x1f"), "dismissed:"+strings.Join(p.Dismissed, "\x1f"))
	return strings.Join(parts, "\n")
}

type scanItem struct {
	pr    int
	check Check
	class string
}

type readJob struct {
	key   string
	check Check
	decl  *Declaration
}

// Assess recognises the failed scans among the listed pull requests' checks, reads their advisories, and says which
// blocks are shared. Reading is bounded, cached by run and job, and never fails: what could not be read is in Unread.
func (r *Reader) Assess(ctx context.Context, gh Gh, in Input) Result {
	result := Result{Blocks: []Block{}, Offers: []Offer{}, Unread: []Unread{}}
	var scans, candidates []scanItem
	for _, pr := range in.Prs {
		for _, check := range pr.Checks {
			switch class := in.Policy.Classify(check); class {
			case ClassDeclared, ClassConfirmed:
				scans = append(scans, scanItem{pr.Number, check, class})
			case ClassCandidate:
				candidates = append(candidates, scanItem{pr.Number, check, class})
			}
		}
	}
	readings := r.readAll(ctx, gh, in, append(append([]scanItem{}, scans...), candidates...))
	result.Offers = offersOf(candidates, readings)
	if len(scans) == 0 {
		return result
	}
	trunk := r.trunkFacts(ctx, gh, in, scans)
	facts, unread := prFactsOf(in, scans, readings)
	result.Unread = unread
	r.addFiles(ctx, gh, in, facts)
	var extra []string
	if in.Policy.Declaration != nil {
		extra = in.Policy.Declaration.DependencyFiles
	}
	result.Blocks = buildBlocks(facts, trunk, extra)
	return result
}

func readingKey(item scanItem) string {
	return fmt.Sprintf("%d:%d:%s", item.check.RunId, item.check.JobId, item.class)
}

// readAll reads the advisories of every distinct run and job once, a few at a time.
func (r *Reader) readAll(ctx context.Context, gh Gh, in Input, items []scanItem) map[string]Reading {
	var jobs []readJob
	seen := map[string]bool{}
	for _, item := range items {
		key := readingKey(item)
		if seen[key] {
			continue
		}
		seen[key] = true
		// Only a declared check has a report to read; a confirmed or offered one is read from its failed log.
		var decl *Declaration
		if item.class == ClassDeclared {
			decl = in.Policy.Declaration
		}
		jobs = append(jobs, readJob{key, item.check, decl})
	}
	readings := make(map[string]Reading, len(jobs))
	var lock sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, readersAtOnce)
	for _, job := range jobs {
		wg.Add(1)
		slots <- struct{}{}
		go func(job readJob) {
			defer func() { panichandler.PanicHandler("molten:secfix:read", recover()) }()
			defer wg.Done()
			defer func() { <-slots }()
			reading := r.ReadCheck(ctx, gh, in.Dir, job.decl, job.check)
			lock.Lock()
			defer lock.Unlock()
			readings[job.key] = reading
		}(job)
	}
	wg.Wait()
	return readings
}

// offersOf lists the checks that look like a scan and whose failed log names advisories, once each.
func offersOf(candidates []scanItem, readings map[string]Reading) []Offer {
	byCheck := map[string]*Offer{}
	var order []string
	for _, item := range candidates {
		reading := readings[readingKey(item)]
		if len(reading.Advisories) == 0 {
			continue
		}
		offer := byCheck[item.check.Name]
		if offer == nil {
			offer = &Offer{Check: CleanLine(item.check.Name, 80), Workflow: CleanLine(item.check.Workflow, 80), Ids: []string{}, Prs: []int{}}
			byCheck[item.check.Name] = offer
			order = append(order, item.check.Name)
		}
		offer.Ids = unionIds(offer.Ids, Ids(reading.Advisories))
		if !slices.Contains(offer.Prs, item.pr) {
			offer.Prs = append(offer.Prs, item.pr)
		}
	}
	offers := []Offer{}
	for _, name := range order {
		offer := byCheck[name]
		sort.Ints(offer.Prs)
		offers = append(offers, *offer)
	}
	sort.Slice(offers, func(i, j int) bool { return offers[i].Check < offers[j].Check })
	return offers
}

func unionIds(a []string, b []string) []string {
	set := map[string]bool{}
	for _, id := range a {
		set[id] = true
	}
	for _, id := range b {
		set[id] = true
	}
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// trunkFacts reads the scan's verdict on the trunk for each distinct scan check of the pull requests.
func (r *Reader) trunkFacts(ctx context.Context, gh Gh, in Input, scans []scanItem) trunkFacts {
	var facts trunkFacts
	seen := map[string]bool{}
	var lists [][]Advisory
	for _, item := range scans {
		key := item.check.Workflow + "\x00" + item.check.Name
		if seen[key] {
			continue
		}
		seen[key] = true
		var decl *Declaration
		if item.class == ClassDeclared {
			decl = in.Policy.Declaration
		}
		trunk := r.TrunkOf(ctx, gh, in.Dir, in.Trunk, decl, item.check)
		// A scan that could not run on the trunk fails it for no advisory: it says nothing of the pull requests'.
		if !trunk.Failing || trunk.Reading.Status == StatusScannerInputFailure {
			continue
		}
		facts.Failing = true
		if facts.Run == 0 || trunk.Run > facts.Run {
			facts.Run = trunk.Run
		}
		lists = append(lists, trunk.Reading.Advisories)
	}
	facts.Advisories = mergeAdvisories(lists...)
	return facts
}

// prFactsOf gathers, for each pull request with a failed scan, what its checks name; a pull request whose scan named
// nothing readable is in the unread list instead.
func prFactsOf(in Input, scans []scanItem, readings map[string]Reading) ([]prFacts, []Unread) {
	byPr := map[int]*prFacts{}
	causes := map[int]string{}
	var order []int
	for _, item := range scans {
		facts := byPr[item.pr]
		if facts == nil {
			facts = &prFacts{Number: item.pr, Origin: OriginDeclared, Source: SourceReport}
			for _, pr := range in.Prs {
				if pr.Number == item.pr {
					facts.HeadOid = pr.HeadOid
				}
			}
			byPr[item.pr] = facts
			order = append(order, item.pr)
		}
		facts.Checks = append(facts.Checks, CleanLine(item.check.Name, 80))
		if item.class != ClassDeclared {
			facts.Origin = OriginConfirmed
		}
		reading := readings[readingKey(item)]
		if len(reading.Advisories) == 0 {
			cause := reading.Cause
			if cause == "" {
				cause = CauseNoAdvisory
			}
			if causes[item.pr] == "" || cause == CauseScannerInputFailure {
				causes[item.pr] = cause
			}
			continue
		}
		if reading.Source != SourceReport {
			facts.Source = SourceLog
		}
		facts.Advisories = mergeAdvisories(facts.Advisories, reading.Advisories)
	}
	sort.Ints(order)
	var prs []prFacts
	var unread []Unread
	for _, number := range order {
		facts := byPr[number]
		sort.Strings(facts.Checks)
		if len(facts.Advisories) == 0 {
			unread = append(unread, Unread{Pr: number, Checks: facts.Checks, Cause: causes[number]})
			continue
		}
		prs = append(prs, *facts)
	}
	return prs, unread
}

// addFiles reads the files of each pull request that is in a block, a few at a time.
func (r *Reader) addFiles(ctx context.Context, gh Gh, in Input, prs []prFacts) {
	var wg sync.WaitGroup
	slots := make(chan struct{}, readersAtOnce)
	for i := range prs {
		wg.Add(1)
		slots <- struct{}{}
		go func(pr *prFacts) {
			defer func() { panichandler.PanicHandler("molten:secfix:files", recover()) }()
			defer wg.Done()
			defer func() { <-slots }()
			files, err := r.PrFiles(ctx, gh, in.Dir, pr.Number, pr.HeadOid)
			if err != nil {
				return
			}
			pr.Files, pr.FilesKnown = files, true
		}(&prs[i])
	}
	wg.Wait()
}
