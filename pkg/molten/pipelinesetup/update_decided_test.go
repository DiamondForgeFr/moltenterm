// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package pipelinesetup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A choice the developer made at an update is not offered again (#1843). The shape is MoltenTerm's own repository:
// testdata/moltenterm-before-1786.json is its pipeline before the #1786 update, whose finalize steps are hand-written
// (a template id running molten release finalize, so without a record they read as the template's), and
// testdata/moltenterm-1786.json is what #1786 merged: the pipeline tab's agent kept those finalize steps in its
// refined text while the template's version stayed ticked, and the record then remembered no choice.

const moltenTermManifest = `{
    "mainBranch": "main",
    "workflow": {
        "workingBranch": "develop",
        "prTargetBranch": "develop",
        "branchNaming": { "feature": "feature/{N}-{description}", "fix": "fix/{N}-{description}", "release": "rc-{version}" },
        "commitFormat": { "pattern": "type(#N): description", "requireTicket": true }
    }
}
`

const moltenTermReleaseYml = `name: Release
on:
    push:
        tags: ["v*"]
    workflow_dispatch:
jobs:
    build:
        runs-on: macos-latest
        steps:
            - run: task package
`

const moltenTermCiYml = `name: CI
on:
    pull_request:
        branches: [develop, main]
    push:
        branches: [develop, main]
    workflow_dispatch:
jobs:
    gotest:
        runs-on: ubuntu-latest
        steps:
            - run: go test ./cmd/... ./pkg/...
`

func testdataText(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// moltenTermRepository: develop and main, main unprotected, the pipeline as it was before #1786 on both.
func moltenTermRepository(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Setup test")
	t.Setenv("GIT_AUTHOR_EMAIL", "setup@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Setup test")
	t.Setenv("GIT_COMMITTER_EMAIL", "setup@example.invalid")
	base := t.TempDir()
	dir := filepath.Join(base, "moltenterm")
	origin := filepath.Join(base, "github-origin.git")
	gitIn(t, base, "init", "--quiet", "--bare", "-b", "develop", origin)
	gitIn(t, base, "init", "--quiet", "-b", "develop", dir)
	writeFiles(t, dir, map[string]string{
		".molten/project.json":                testdataText(t, "moltenterm-before-1786.json"),
		".saasfoundry.json":                   moltenTermManifest,
		"package.json":                        `{ "name": "moltenterm", "version": "1.0.0-7" }`,
		"package-lock.json":                   `{ "name": "moltenterm", "version": "1.0.0-7", "packages": { "": { "version": "1.0.0-7" } } }`,
		".github/workflows/release.yml":       moltenTermReleaseYml,
		".github/workflows/ci.yml":            moltenTermCiYml,
		"build/moltenterm/icon.svg":           "<svg/>\n",
		"scripts/moltenterm-check-ledger.mjs": "\n",
		"scripts/moltenterm-build-gold.sh":    "#!/bin/sh\n",
	})
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore: bootstrap")
	gitIn(t, dir, "remote", "add", "origin", origin)
	gitIn(t, dir, "push", "--quiet", "origin", "develop", "develop:main")
	gitIn(t, dir, "fetch", "--quiet", "origin")
	return dir
}

// moltenTermForge: main has no rule asking for pull requests.
func moltenTermForge(t *testing.T) Runner {
	inner := (&fakeForge{}).runner(t, "[]")
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		if name == "gh" && len(args) >= 2 && args[0] == "api" {
			switch {
			case strings.HasSuffix(args[1], "/rules/branches/main"):
				return []byte("[]"), nil
			case strings.HasSuffix(args[1], "/branches/main/protection"):
				return nil, errors.New("gh: Branch not protected (HTTP 404)")
			}
		}
		return inner(ctx, dir, name, args...)
	}
}

func commitRecord(t *testing.T, dir string, rec Record) {
	t.Helper()
	data, err := recordText(&rec)
	if err != nil {
		t.Fatal(err)
	}
	writeFiles(t, dir, map[string]string{RecordFile: string(data)})
	gitIn(t, dir, "add", RecordFile)
	gitIn(t, dir, "commit", "--quiet", "-m", "chore(#3): the record")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
}

func reasonCodes(reasons []UpdateReason) string {
	var codes []string
	for _, r := range reasons {
		codes = append(codes, r.Code)
	}
	return strings.Join(codes, ",")
}

func TestUpdateRemembersTheStepsTheAgentKept(t *testing.T) {
	dir := moltenTermRepository(t)
	s := MakeSetup(moltenTermForge(t), nil)
	s.TreesDir = t.TempDir()
	ctx := context.Background()
	check, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ChangeKeys(check.Changes), ","); got != "changed:public/finalize,changed:public/promote,changed:rc/finalize,changed:rc/promote" {
		t.Fatalf("changes before #1786: %s", got)
	}
	for _, c := range check.Changes {
		if c.Customised || !c.Take {
			t.Fatalf("without a record, %s reads as the template's: %+v", c.Key, c)
		}
	}
	updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature, Refined: testdataText(t, "moltenterm-1786.json")})
	if public := readPipeline(t, dir).Release.Public; !strings.Contains(public[indexOf(public, "finalize")].Title, "leaves a draft release") {
		t.Fatalf("the agent's finalize was not kept: %+v", public)
	}
	rec := readRecordFile(t, dir)
	if rec == nil || rec.Declined["rc/finalize"] == "" || rec.Declined["public/finalize"] == "" || len(rec.Declined) != 2 {
		t.Fatalf("the record forgets the kept steps: %+v", rec)
	}
	if rec.Steps["rc/promote"] == "" || rec.Steps["rc/finalize"] != "" {
		t.Fatalf("record steps: %+v", rec.Steps)
	}
	again, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if again.State != UpdateStateUpToDate || len(again.Changes) != 0 || len(again.Reasons) != 0 {
		t.Fatalf("a kept step is offered again: %s %v %+v", again.State, ChangeKeys(again.Changes), again.Reasons)
	}
}

// The record #1786 wrote, before #1843: the finalize steps neither the template's nor declined.
func moltenTermRecord1786() Record {
	return Record{Template: 2, Steps: map[string]string{
		"public/close-milestone": "c3053b36148b", "public/prepare": "596855021326", "public/promote": "f9aeb729ec3c",
		"public/rewrite-notes": "5436867c2a4f", "public/sync-back": "59a826c0f381", "rc/prepare": "596855021326",
		"rc/promote": "f9aeb729ec3c", "rc/rewrite-notes": "5436867c2a4f", "rc/sync-back": "59a826c0f381",
	}}
}

func TestCheckOnMoltenTermsSetupAfter1786(t *testing.T) {
	dir := moltenTermRepository(t)
	commitPipeline(t, dir, testdataText(t, "moltenterm-1786.json"))
	rec := moltenTermRecord1786()
	commitRecord(t, dir, rec)
	s := MakeSetup(moltenTermForge(t), nil)
	ctx := context.Background()

	// What the Release menu offered on MoltenTerm (#1843): both finalize steps, as customised.
	check, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ChangeKeys(check.Changes), ","); got != "changed:public/finalize,changed:rc/finalize" || reasonCodes(check.Reasons) != UpdateReasonCustomised {
		t.Fatalf("changes %s, reasons %+v", got, check.Reasons)
	}
	finalize, _ := changeByKey(check.Changes, "rc/finalize")

	// The choice recorded for this template version: nothing to offer.
	rec.Declined = map[string]string{"rc/finalize": changeHash(finalize), "public/finalize": changeHash(finalize)}
	commitRecord(t, dir, rec)
	check, err = s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if check.State != UpdateStateUpToDate || len(check.Changes) != 0 || len(check.Reasons) != 0 {
		t.Fatalf("a decided step is offered again: %s %v %+v", check.State, ChangeKeys(check.Changes), check.Reasons)
	}

	// The template wrote rc/finalize differently since the choice: offered again, saying so, with its diff.
	rec.Declined["rc/finalize"] = "000000000000"
	commitRecord(t, dir, rec)
	check, err = s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ChangeKeys(check.Changes), ","); got != "changed:rc/finalize" {
		t.Fatalf("changes: %s", got)
	}
	c := check.Changes[0]
	if !c.Customised || c.Take || !strings.Contains(c.Before, "publishes the prerelease") || !strings.Contains(c.After, "release.yml starts on the tag") {
		t.Fatalf("change: %+v", c)
	}
	want := UpdateReason{Code: UpdateReasonChangedSince, Detail: "Commit, tag and push: release.yml builds macOS and Linux and publishes the prerelease"}
	if len(check.Reasons) != 1 || check.Reasons[0] != want {
		t.Fatalf("reasons: %+v", check.Reasons)
	}
}
