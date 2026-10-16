// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The windows word Mission Control's refusals from their codes (#656); the English stays as it was, for the logs,
// `molten` and the agents.

func checkCoded(t *testing.T, err error, code string, vars map[string]string, english string) {
	t.Helper()
	if err == nil {
		t.Fatalf("no error, want %s", code)
	}
	if err.Error() != english {
		t.Errorf("English %q, want %q", err.Error(), english)
	}
	text := uimsg.TextOf(err)
	if text == nil || text.Code != code {
		t.Fatalf("text %+v, want the code %s", text, code)
	}
	if len(vars) > 0 && !reflect.DeepEqual(text.Vars, vars) {
		t.Errorf("%s vars %v, want %v", code, text.Vars, vars)
	}
}

func TestPipelineRefusalsCarryCodes(t *testing.T) {
	checkCoded(t, pipelineError(molten.PipelineReport{}), "mission.noPipeline", nil, "the project has no pipeline (.molten/project.json)")
	checkCoded(t, pipelineError(molten.PipelineReport{Present: true, Errors: []string{"a", "b"}}), "mission.pipelineProblems",
		map[string]string{"detail": "a; b"}, "the pipeline has problems: a; b")
	checkCoded(t, errStillRunning("Build"), "mission.run.stillRunning", map[string]string{"title": "Build"}, "Build is still running")
	checkCoded(t, errAlreadyRunning("Build"), "mission.run.alreadyRunning", map[string]string{"title": "Build"}, "Build is already running")
	checkCoded(t, errNotFollowed("v1.0.0"), "mission.release.notFollowed", map[string]string{"tag": "v1.0.0"}, "v1.0.0 is not the release followed")
}

func TestDepSyncRefusalsCarryCodes(t *testing.T) {
	declared := []molten.PipelineDependency{{Project: "lib"}}
	_, err := pickSyncDeclaration(declared, DepSyncRequest{Project: "other"}, nil)
	checkCoded(t, err, "mission.depSync.noDependencyOn", map[string]string{"project": "other"}, "the project declares no dependency on other")
	_, err = pickSyncDeclaration(declared, DepSyncRequest{}, nil)
	checkCoded(t, err, "mission.depSync.noSyncAny", map[string]string{"file": molten.ProjectPipelineFile},
		"no dependency declares a sync command: add \"sync\" to one in "+molten.ProjectPipelineFile)
	_, err = pickSyncDeclaration(declared, DepSyncRequest{Project: "lib"}, nil)
	checkCoded(t, err, "mission.depSync.noSync", map[string]string{"project": "lib", "file": molten.ProjectPipelineFile},
		"no sync command is declared for the dependency on lib: add \"sync\" to it in "+molten.ProjectPipelineFile)
	_, err = pickSyncDeclaration(nil, DepSyncRequest{}, nil)
	checkCoded(t, err, "mission.depSync.noDependency", nil, "the project declares no dependency (\"dependson\")")
	_, err = findSource(nil, "/p", "lib")
	checkCoded(t, err, "mission.deps.noGroup", nil, "this project is in no group: add \"group\" to its .molten/project.json and to the source's")
}

func TestResultTextsCarryCodes(t *testing.T) {
	wf := ParseWorkflow("bad.yml", "on: [push\n")
	if wf.Error == "" || wf.ErrorText == nil || wf.ErrorText.Code != "mission.jobs.badYaml" || wf.ErrorText.Vars["detail"] == "" {
		t.Errorf("unreadable YAML: %q %+v", wf.Error, wf.ErrorText)
	}
	wf = ParseWorkflow("list.yml", "- a\n")
	if wf.Error != "not a workflow: the file holds no mapping" || wf.ErrorText == nil || wf.ErrorText.Code != "mission.jobs.noMapping" {
		t.Errorf("no mapping: %q %+v", wf.Error, wf.ErrorText)
	}
	item := runWork(RunRecord{Id: "r", Preparing: true})
	if item.Detail != "preparing" || item.DetailText == nil || item.DetailText.Code != "mission.work.preparing" {
		t.Errorf("preparing: %q %+v", item.Detail, item.DetailText)
	}
	item = runWork(RunRecord{Id: "r", Phases: []string{"compile"}})
	if item.Detail != "compile" || item.DetailText != nil {
		t.Errorf("a phase is the project's own word: %q %+v", item.Detail, item.DetailText)
	}
}
