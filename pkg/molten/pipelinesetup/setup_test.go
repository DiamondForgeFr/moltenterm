// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
)

const sfPipeline = `{
    "schema": 1,
    "name": "SaaSFoundryAI",
    "versions": {
        "tagprefix": "v",
        "firstpublic": "1.0.0",
        "files": [
            { "path": "package.json", "format": "json", "keys": [["version"]] },
            { "path": ".saasfoundry.json", "format": "json", "keys": [["version"]] }
        ]
    },
    "ci": {
        "prepare": { "run": "npm ci" },
        "jobs": [
            { "name": "lint", "title": "Lint", "lane": "static", "run": "npm run lint" }
        ]
    }
}
`

const sfManifest = `{
  "version": "1.0.4",
  "workflow": {
    "workingBranch": "develop",
    "prTargetBranch": "develop",
    "releaseBranch": "master",
    "branchNaming": { "feature": "feature/{N}-{description}", "fix": "fix/{N}-{description}", "release": "rc-{version}" },
    "commitFormat": { "pattern": "<type>(#<ticket>): <description>", "requireTicket": true }
  }
}
`

const publishStable = `name: Publish stable package
on:
  push:
    tags: ['v[0-9]+.[0-9]+.[0-9]+']
  workflow_dispatch:
    inputs:
      tag:
        description: Exact stable tag
        required: true
        type: string
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-production
    steps:
      - run: npm publish --provenance --access public --tag latest
`

const deployDocs = `name: Deploy Documentation
on:
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/deploy-pages@v4
`

const testYml = `name: Tests
on:
  push:
    branches: [master, develop, 'rc-*']
    tags: ['v*', 'rc-*']
  pull_request:
    branches: [master, develop]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`

const deployApi = `name: Deployment API
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: docker/build-push-action@v7
`

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for path, text := range files {
		full := filepath.Join(dir, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func saasFoundryFixture(t *testing.T) string {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		".molten/project.json":                 sfPipeline,
		".saasfoundry.json":                    sfManifest,
		"package.json":                         `{ "name": "saasfoundryai", "version": "1.0.4" }`,
		".github/workflows/publish-stable.yml": publishStable,
		".github/workflows/deploy-docs.yml":    deployDocs,
		".github/workflows/test.yml":           testYml,
		"docs/changelog.md":                    "# Changelog\n",
		"docs/fr/changelog.md":                 "# Journal\n",
		".git/config":                          "[remote \"origin\"]\n\turl = git@github.com:DiamondForgeFr/SaasFoundryAI.git\n",
	})
	return dir
}

func noSf(context.Context, string, string, ...string) ([]byte, error) {
	return nil, errors.New("sf: command not found")
}

func stepIds(steps []molten.PipelineStep) []string {
	var rtn []string
	for _, s := range steps {
		rtn = append(rtn, s.Id)
	}
	return rtn
}

func TestDraftSaaSFoundryShapedRepository(t *testing.T) {
	dir := saasFoundryFixture(t)
	before, _ := os.ReadFile(filepath.Join(dir, ".molten/project.json"))
	s := MakeSetup(noSf, nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if answer.Provider != ProviderMoltenTerm || answer.Facts.Kind != KindOnPremise {
		t.Fatalf("provider %s kind %s", answer.Provider, answer.Facts.Kind)
	}
	if len(answer.Errors) > 0 {
		t.Fatalf("the draft is not valid: %v\n%s", answer.Errors, answer.Proposed)
	}
	rc, public := answer.Proposal.Release.Rc, answer.Proposal.Release.Public
	if got := strings.Join(stepIds(rc), ","); got != "promote,prepare,changelog-en,changelog-fr,finalize,sync-back" {
		t.Fatalf("rc steps: %s", got)
	}
	if got := strings.Join(stepIds(public), ","); got != "promote,prepare,changelog-en,changelog-fr,finalize,close-milestone,dispatch-deploy-docs,sync-back" {
		t.Fatalf("public steps: %s", got)
	}
	if rc[0].Run != "molten release promote --workflow test.yml" {
		t.Fatalf("promote: %s", rc[0].Run)
	}
	finalize := public[4]
	if !strings.Contains(finalize.Confirm, "publish-stable.yml") || !strings.Contains(finalize.Confirm, "npm-production") {
		t.Fatalf("public finalize confirm: %s", finalize.Confirm)
	}
	if strings.Contains(rc[4].Confirm, "publish-stable.yml") {
		t.Fatalf("the RC tag does not start publish-stable: %s", rc[4].Confirm)
	}
	if public[6].Run != "molten release dispatch deploy-docs.yml --ref {tag}" {
		t.Fatalf("dispatch: %s", public[6].Run)
	}
	if !public[2].IsManual() || public[2].Phase != "cut" {
		t.Fatalf("changelog step: %+v", public[2])
	}
	for _, key := range []string{"rc/promote", "rc/prepare", "public/finalize", "public/dispatch-deploy-docs", "public/changelog-fr"} {
		if answer.Proposal.Sources[key].Code == "" {
			t.Fatalf("no source for %s: %v", key, answer.Proposal.Sources)
		}
	}
	if answer.Proposal.Sources["rc/promote"].Path != molten.BranchFromSfWorkingBranch+" / "+molten.BranchFromSfReleaseBranch {
		t.Fatalf("promote source: %+v", answer.Proposal.Sources["rc/promote"])
	}
	if !strings.HasPrefix(answer.Proposed, strings.Split(sfPipeline, `    "ci"`)[0][:40]) {
		t.Fatalf("the head of the file changed:\n%s", answer.Proposed)
	}
	if !strings.Contains(answer.Proposed, `{ "name": "lint", "title": "Lint", "lane": "static", "run": "npm run lint" }`) {
		t.Fatalf("the ci block is not kept byte for byte:\n%s", answer.Proposed)
	}
	after, _ := os.ReadFile(filepath.Join(dir, ".molten/project.json"))
	if string(after) != string(before) {
		t.Fatal("the draft wrote the file")
	}
	if !answer.Facts.TicketBranches {
		t.Fatal("the commit format requires a ticket")
	}
}

func TestWriteOnlyTheReviewedTextWhenTheFileIsUnchanged(t *testing.T) {
	dir := saasFoundryFixture(t)
	s := MakeSetup(noSf, nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(WriteRequest{Dir: dir, Text: answer.Proposed, Base: "stale"}); err == nil {
		t.Fatal("a stale base is refused")
	}
	if _, err := s.Write(WriteRequest{Dir: dir, Text: `{"schema": 1}`, Base: answer.Base}); err == nil {
		t.Fatal("an invalid pipeline is refused")
	}
	if _, err := s.Write(WriteRequest{Dir: dir, Text: answer.Proposed, Base: answer.Base}); err != nil {
		t.Fatal(err)
	}
	report := molten.ValidatePipeline(dir)
	if !report.Valid || len(report.Pipeline.Release.Rc) == 0 || len(report.Pipeline.Release.Public) == 0 {
		t.Fatalf("written: %+v", report)
	}
	again := Detect(dir)
	if len(again.Missing) != 0 {
		t.Fatalf("still missing: %v", again.Missing)
	}
}

func TestDraftWithoutPipelineCreatesTheFile(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"package.json":                  `{ "name": "tool", "version": "0.3.0", "private": true }`,
		"electron-builder.config.cjs":   `module.exports = { win: { target: ["nsis", "msi"] } };`,
		".github/workflows/release.yml": "on:\n  push:\n    tags: ['v*']\njobs:\n  b:\n    runs-on: x\n    steps:\n      - run: npx electron-builder --publish always\n",
	})
	s := MakeSetup(noSf, nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if answer.Base != "" || answer.Current != "" {
		t.Fatal("there is no file yet")
	}
	if len(answer.Errors) > 0 {
		t.Fatalf("%v\n%s", answer.Errors, answer.Proposed)
	}
	var p molten.Pipeline
	if err := json.Unmarshal([]byte(answer.Proposed), &p); err != nil || p.Schema != 1 || p.Versions == nil || len(p.Versions.Files) != 1 {
		t.Fatalf("%v %s", err, answer.Proposed)
	}
	var rcdot Choice
	for _, c := range answer.RcFormats {
		if c.Id == RcFormatRcDot {
			rcdot = c
		}
	}
	if rcdot.Allowed || rcdot.Reasons[0].Code != ReasonMsiNumeric {
		t.Fatalf("an msi target refuses -rc.N first: %+v", rcdot)
	}
}

func TestSaasKindDraftsDeploySteps(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		".molten/project.json":                 `{ "schema": 1, "name": "DiamondForge" }`,
		"package.json":                         `{ "name": "df", "version": "1.0.0", "private": true }`,
		".github/workflows/deployment-api.yml": deployApi,
	})
	s := MakeSetup(noSf, nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if answer.Facts.Kind != KindSaas {
		t.Fatalf("kind %s %+v", answer.Facts.Kind, answer.Facts.KindEvidence)
	}
	if len(answer.Proposal.Steps) != 1 || answer.Proposal.Steps[0].Environment != "production" ||
		answer.Proposal.Steps[0].Run != "molten release dispatch deployment-api.yml --ref main" {
		t.Fatalf("%+v", answer.Proposal.Steps)
	}
	if len(answer.Errors) > 0 {
		t.Fatalf("%v", answer.Errors)
	}
}

func TestManualStepBeforePromoteMovesThePreparation(t *testing.T) {
	dir := saasFoundryFixture(t)
	f := Detect(dir)
	o := DefaultOptions(f)
	o.Manual = []ManualStep{{Id: "merge-ours", Title: "Merge master into develop with -s ours", Text: "git merge -s ours origin/master", Channel: ChannelRc, Before: "promote"}}
	p := Build(f, o, molten.ValidatePipeline(dir).Pipeline)
	rc := p.Release.Rc
	if rc[0].Id != "merge-ours" || !rc[0].IsManual() || rc[0].Phase != "cut" || rc[1].Phase != "cut" || rc[2].Phase != "cut" {
		t.Fatalf("%+v", rc[:3])
	}
	if p.Release.Public[0].Id != "promote" {
		t.Fatal("the manual step is the RC's only")
	}
	text, err := proposedText([]byte(sfPipeline), f, p)
	if err != nil {
		t.Fatal(err)
	}
	if report := molten.ValidatePipelineData(dir, text); !report.Valid {
		t.Fatalf("%v", report.Errors)
	}
}

func TestSaaSFoundryProviderAdapter(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "sf-pipeline-draft.json"))
	if err != nil {
		t.Fatal(err)
	}
	dir := saasFoundryFixture(t)
	var calls []string
	run := func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		if args[len(args)-1] == "--help" {
			return []byte("Usage: sf pipeline draft [--json] [--kind on-premise|saas]"), nil
		}
		return fixture, nil
	}
	s := MakeSetup(run, nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir, Kind: KindOnPremise})
	if err != nil {
		t.Fatal(err)
	}
	if answer.Provider != ProviderSaaSFoundry {
		t.Fatalf("provider %s, warnings %v", answer.Provider, answer.Warnings)
	}
	if calls[1] != "sf pipeline draft --json --kind on-premise" {
		t.Fatalf("calls %v", calls)
	}
	if answer.Proposal.Sources["rc/promote"].Detail == "" || answer.Proposal.Release.Rc[0].Id != "promote" {
		t.Fatalf("%+v", answer.Proposal)
	}
	if len(answer.Errors) > 0 {
		t.Fatalf("%v", answer.Errors)
	}
	broken := func(_ context.Context, _ string, _ string, args ...string) ([]byte, error) {
		if args[len(args)-1] == "--help" {
			return []byte("--json"), nil
		}
		return []byte(`{"schema": 9}`), nil
	}
	answer, err = MakeSetup(broken, nil).Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil || answer.Provider != ProviderMoltenTerm || len(answer.Warnings) != 1 {
		t.Fatalf("a broken provider hands over to the detection: %v %s %v", err, answer.Provider, answer.Warnings)
	}
}

func TestRefineOnlyProposes(t *testing.T) {
	dir := saasFoundryFixture(t)
	before, _ := os.ReadFile(filepath.Join(dir, ".molten/project.json"))
	var gotArgv []string
	var gotPrompt string
	agent := func(_ context.Context, _ string, argv []string, prompt string) ([]byte, error) {
		gotArgv, gotPrompt = argv, prompt
		return []byte("Here it is:\n```json\n" + strings.Replace(sfPipeline, `"name": "SaaSFoundryAI"`, `"name": "Refined"`, 1) + "```\n"), nil
	}
	s := MakeSetup(noSf, agent)
	s.ChooseAgent = func(string) agentchoice.Choice {
		return agentchoice.Choice{Agent: molten.AgentIdClaude, AgentName: "Claude Code"}
	}
	answer, err := s.Refine(context.Background(), RefineRequest{Dir: dir, Text: sfPipeline})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(answer.Proposed, `"Refined"`) || len(answer.Errors) > 0 {
		t.Fatalf("%+v", answer)
	}
	if !strings.Contains(strings.Join(gotArgv, " "), "--disallowed-tools Bash Edit Write") {
		t.Fatalf("argv %v", gotArgv)
	}
	if !strings.Contains(gotPrompt, "Do not write or change any file") || !strings.Contains(gotPrompt, `"name": "SaaSFoundryAI"`) {
		t.Fatal("the prompt carries the draft and the rule")
	}
	after, _ := os.ReadFile(filepath.Join(dir, ".molten/project.json"))
	if string(after) != string(before) {
		t.Fatal("refining wrote the file")
	}
}

func TestGithubFilters(t *testing.T) {
	cases := []struct {
		patterns []string
		name     string
		want     bool
	}{
		{[]string{"v[0-9]+.[0-9]+.[0-9]+"}, "v1.2.3", true},
		{[]string{"v[0-9]+.[0-9]+.[0-9]+"}, "v1.2.3-1", false},
		{[]string{"v*"}, "v1.2.3-1", true},
		{[]string{"rc-*"}, "rc-1.0.0", true},
		{[]string{"release/**"}, "release/a/b", true},
		{[]string{"release/*"}, "release/a/b", false},
		{[]string{"v*", "!v*-*"}, "v1.0.0-1", false},
		{[]string{"v*", "!v*-*"}, "v1.0.0", true},
	}
	for _, c := range cases {
		if got := FilterMatches(c.patterns, c.name); got != c.want {
			t.Errorf("%v on %s: %v", c.patterns, c.name, got)
		}
	}
}

func TestMergeKeepsOtherKeys(t *testing.T) {
	current := "{\n  \"schema\": 1,\n  \"name\": \"X\",\n  \"ci\": { \"jobs\": [ {\"name\":\"a\",\"run\":\"true\"} ] }\n}\n"
	out, err := MergeTopLevel([]byte(current), nil, []keyValue{{Key: "name", Value: "Y"}, {Key: "release", Value: map[string]any{"rc": []any{}}}})
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"schema\": 1,\n  \"name\": \"Y\",\n  \"ci\": { \"jobs\": [ {\"name\":\"a\",\"run\":\"true\"} ] },\n  \"release\": { \"rc\": [] }\n}\n"
	if string(out) != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}
}

func TestEvaluateChoicesWithoutTargets(t *testing.T) {
	choices := EvaluateChoices([]string{RcFormatNumeric, RcFormatRcDot}, RcFormatRules, nil)
	if !choices[0].Allowed || choices[1].Allowed || len(choices[1].Reasons) != 1 || choices[1].Reasons[0].Code != ReasonChainNumeric {
		t.Fatalf("%+v", choices)
	}
	npm := EvaluateChoices([]string{RcFormatRcDot}, RcFormatRules, []string{TargetNpm})
	if npm[0].Allowed || len(npm[0].Reasons) != 2 || npm[0].Reasons[0].Code != ReasonNpmDistTag {
		t.Fatalf("%+v", npm)
	}
}
