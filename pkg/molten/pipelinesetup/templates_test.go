// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Step 4 (FR-MC-042): a pipeline saved as a template on this computer, offered at step 2b of another project.

func templateSetup(t *testing.T) *Setup {
	t.Helper()
	s := describeSetup(t, &fakeForge{})
	s.TemplatesDir = filepath.Join(t.TempDir(), "molten", "pipeline-templates")
	return s
}

func savedTemplate(t *testing.T, s *Setup, dir string, keepManual bool, keepPublish bool) PipelineTemplate {
	t.Helper()
	o := describedOptions(t, s, dir, func(o *Options) {
		o.Manual = []ManualStep{{Id: "check-store", Title: "Check the store page", Text: "Open the store and check the listing.", Channel: ChannelPublic}}
	})
	answer, err := s.SaveTemplate(context.Background(), TemplateSaveRequest{Dir: dir, Name: "  npm CLI,   PR to main ", AppType: AppTypeCli,
		Options: o, KeepManual: keepManual, KeepPublish: keepPublish})
	if err != nil {
		t.Fatal(err)
	}
	return answer.Template
}

func TestSaveATemplateKeepsTheFlowNotTheProject(t *testing.T) {
	dir := npmCliRepository(t, nil)
	s := templateSetup(t)
	before := workingCopy(t, dir)
	tpl := savedTemplate(t, s, dir, true, true)
	if tpl.Name != "npm CLI, PR to main" || tpl.AppType != AppTypeCli || tpl.From != "invoice-cli" {
		t.Fatalf("template: %+v", tpl)
	}
	f := tpl.Flow
	if f.Rc != RcPublished || f.Single || f.Release != "main" || f.BranchModel != BranchModelPromote || strings.Join(f.Publish, ",") != "npm,githubrelease" {
		t.Fatalf("flow: %+v", f)
	}
	if len(f.Manual) != 1 || f.Manual[0].Id != "check-store" {
		t.Fatalf("manual: %+v", f.Manual)
	}
	entries, err := os.ReadDir(s.TemplatesDir)
	if err != nil || len(entries) != 1 || entries[0].Name() != tpl.Id+".json" {
		t.Fatalf("files: %v %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(s.TemplatesDir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{dir, filepath.Dir(dir), "package.json", "CHANGELOG", "molten-publish"} {
		if strings.Contains(string(data), leak) {
			t.Fatalf("the template holds %q:\n%s", leak, data)
		}
	}
	if info, _ := os.Stat(filepath.Join(s.TemplatesDir, entries[0].Name())); info.Mode().Perm() != 0600 {
		t.Fatalf("mode %v", info.Mode())
	}
	if workingCopy(t, dir) != before {
		t.Fatal("the project changed")
	}
	bare := savedTemplate(t, s, dir, false, false)
	if len(bare.Flow.Manual) != 0 || len(bare.Flow.Publish) != 0 {
		t.Fatalf("not kept: %+v", bare.Flow)
	}
}

func TestSaveATemplateRefuses(t *testing.T) {
	dir := npmCliRepository(t, nil)
	s := templateSetup(t)
	o := describedOptions(t, s, dir, nil)
	ctx := context.Background()
	if _, err := s.SaveTemplate(ctx, TemplateSaveRequest{Dir: dir, Name: " ", AppType: AppTypeCli, Options: o}); err == nil {
		t.Fatal("a blank name was saved")
	}
	if _, err := s.SaveTemplate(ctx, TemplateSaveRequest{Dir: dir, Name: strings.Repeat("x", 81), AppType: AppTypeCli, Options: o}); err == nil {
		t.Fatal("a long name was saved")
	}
	saas := o
	saas.Kind = KindSaas
	if _, err := s.SaveTemplate(ctx, TemplateSaveRequest{Dir: dir, Name: "web", AppType: AppTypeCli, Options: saas}); err == nil {
		t.Fatal("a SaaS pipeline was saved")
	}
	bad := o
	bad.Merge = "octopus"
	if _, err := s.SaveTemplate(ctx, TemplateSaveRequest{Dir: dir, Name: "bad", AppType: AppTypeCli, Options: bad}); err == nil {
		t.Fatal("an unknown merge was saved")
	}
	if _, err := s.SaveTemplate(ctx, TemplateSaveRequest{Dir: dir, Name: "type", AppType: "spaceship", Options: o}); err == nil {
		t.Fatal("an unknown type was saved")
	}
	if _, err := s.DeleteTemplate(TemplateDeleteRequest{Id: "../answers"}); err == nil {
		t.Fatal("a path was taken as an id")
	}
	none := describeSetup(t, &fakeForge{})
	if _, err := none.SaveTemplate(ctx, TemplateSaveRequest{Dir: dir, Name: "x", AppType: AppTypeCli, Options: o}); err == nil {
		t.Fatal("saved without a templates folder")
	}
}

func TestATemplateIsOfferedAndAdaptedOnAnotherProject(t *testing.T) {
	source := npmCliRepository(t, nil)
	s := templateSetup(t)
	tpl := savedTemplate(t, s, source, true, true)
	// A file that is not a template is skipped.
	writeFiles(t, s.TemplatesDir, map[string]string{"0123456789abcdef.json": `{"id":"0123456789abcdef","name":"x","flow":{"merge":"octopus"}}`, "notes.txt": "x"})
	other := npmCliRepository(t, nil)
	before := workingCopy(t, other)
	ctx := context.Background()
	answer, err := s.Templates(ctx, TemplatesRequest{Dir: other, AppType: AppTypeCli})
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Templates) != 1 || answer.Templates[0].Template.Id != tpl.Id {
		t.Fatalf("templates: %+v", answer.Templates)
	}
	fit := answer.Templates[0]
	// type, branches, npm and GitHub Release reachable but no workflow publishes them yet.
	if !fit.SameType || fit.Total != 4 || fit.Met != 2 {
		t.Fatalf("fit: %d/%d %+v", fit.Met, fit.Total, fit.Needs)
	}
	o := fit.Options
	if o.Rc != RcPublished || o.Trunk != "develop" || o.Release != "main" || strings.Join(o.Publish, ",") != "npm,githubrelease" || len(o.Manual) != 1 {
		t.Fatalf("adapted: %+v", o)
	}
	draft, err := s.Draft(ctx, DraftRequest{Dir: other, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	if len(draft.Errors) > 0 || len(draft.Files) != 1 || !strings.Contains(draft.Files[0].Content, "--tag next") {
		t.Fatalf("the template's draft: %v %+v", draft.Errors, draft.Files)
	}
	if _, ok := stepById(releaseOf(t, draft.Proposed).Public, "check-store"); !ok {
		t.Fatalf("the template's hand step is missing:\n%s", draft.Proposed)
	}
	lib, err := s.Templates(ctx, TemplatesRequest{Dir: other, AppType: AppTypeLibrary})
	if err != nil || lib.Templates[0].SameType || lib.Templates[0].Needs[0].Ok {
		t.Fatalf("another type: %+v %v", lib.Templates, err)
	}
	if workingCopy(t, other) != before {
		t.Fatal("the project changed")
	}
	deleted, err := s.DeleteTemplate(TemplateDeleteRequest{Id: tpl.Id})
	if err != nil || !deleted.Deleted {
		t.Fatalf("delete: %v %v", deleted, err)
	}
	after, err := s.Templates(ctx, TemplatesRequest{Dir: other, AppType: AppTypeCli})
	if err != nil || len(after.Templates) != 0 {
		t.Fatalf("after delete: %+v %v", after, err)
	}
}

func TestTemplateOptionsOnASingleBranchProject(t *testing.T) {
	here := Facts{OnGithub: false, TagPrefix: "v"}
	here.Branches.Trunk, here.Branches.Release = "main", "main"
	tpl := PipelineTemplate{Flow: TemplateFlow{BranchModel: BranchModelPromote, Release: "master", Merge: MergeCommit, RcFormat: RcFormatNumeric,
		Rc: RcNone, SyncBack: true, Milestone: true, Publish: []string{TargetNpm, TargetGithubRelease}}}
	fit := FitTemplate(here, AppTypeCli, tpl)
	o := fit.Options
	if o.Release != "master" || o.Milestone || len(o.Publish) != 0 || strings.Join(o.Channels, ",") != ChannelPublic {
		t.Fatalf("adapted: %+v", o)
	}
	if fit.Needs[1].Code != NeedBranches || fit.Needs[1].Ok || fit.Needs[1].Value != "master" {
		t.Fatalf("needs: %+v", fit.Needs)
	}
	single := tpl
	single.Flow.Single, single.Flow.BranchModel = true, BranchModelSingle
	here.Branches.Release = "release"
	if o := TemplateOptions(here, single); o.Release != "main" || o.BranchModel != BranchModelSingle || o.SyncBack {
		t.Fatalf("single: %+v", o)
	}
}

func TestAnswersKeepTheTemplate(t *testing.T) {
	dir := npmCliRepository(t, nil)
	s := templateSetup(t)
	s.AnswersDir = t.TempDir()
	if _, err := s.SaveAnswers(AnswersRequest{Dir: dir, Answers: &Answers{Path: PathDescribe, From: FromTemplate, Template: "0123456789abcdef"}}); err != nil {
		t.Fatal(err)
	}
	if a := s.loadAnswers(dir, ""); a == nil || a.Template != "0123456789abcdef" || a.From != FromTemplate {
		t.Fatalf("answers: %+v", a)
	}
	if _, err := s.SaveAnswers(AnswersRequest{Dir: dir, Answers: &Answers{From: FromTemplate, Template: "../x"}}); err == nil {
		t.Fatal("a bad template id was kept")
	}
}
