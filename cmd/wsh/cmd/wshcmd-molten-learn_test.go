// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

func isLearnUsage(err error) bool {
	var usage moltenLearnUsageError
	return errors.As(err, &usage)
}

func TestParseMoltenLearnRecord(t *testing.T) {
	const wf = "pipeline-setup"
	got, err := parseMoltenLearnRecord(wf, "", "", "merge=squash", "merge", "", "", "project-a")
	want := molten.LearningRequest{Workflow: wf, Kind: molten.LearningKindCorrection, Key: "merge", Value: "squash", Proposed: "merge", Run: "project-a"}
	if err != nil || got != want {
		t.Fatalf("correction: %+v %v", got, err)
	}
	if got, err := parseMoltenLearnRecord(wf, "apptype=desktop=x", "", "", "", "", "", ""); err != nil || got.Kind != molten.LearningKindAnswer || got.Key != "apptype" || got.Value != "desktop=x" {
		t.Fatalf("the value keeps its equal signs: %+v %v", got, err)
	}
	if got, err := parseMoltenLearnRecord(wf, "", "style=calm", "", "", "", "", ""); err != nil || got.Kind != molten.LearningKindPreference {
		t.Fatalf("preference: %+v %v", got, err)
	}
	if got, err := parseMoltenLearnRecord(wf, "", "", "", "", "template", "", ""); err != nil || got.Kind != molten.LearningKindSkip || got.Key != "template" || got.Value != "" {
		t.Fatalf("skip: %+v %v", got, err)
	}
	if got, err := parseMoltenLearnRecord(wf, "", "", "", "", "", "template", ""); err != nil || got.Kind != molten.LearningKindDone {
		t.Fatalf("done: %+v %v", got, err)
	}
	for name, c := range map[string][8]string{
		"nothing":            {},
		"two kinds":          {"a=b", "c=d"},
		"skip and done":      {"", "", "", "", "a", "b"},
		"no equal sign":      {"merge"},
		"no value":           {"merge="},
		"no key":             {"=squash"},
		"proposed alone":     {"", "", "", "x", "step"},
		"proposed on answer": {"a=b", "", "", "x"},
	} {
		if _, err := parseMoltenLearnRecord("wf", c[0], c[1], c[2], c[3], c[4], c[5], c[6]); !isLearnUsage(err) {
			t.Errorf("%s: %v, want bad usage", name, err)
		}
	}
}

func fakeLearn(t *testing.T, answers map[string]any) (moltenLearnCaller, *[]string) {
	t.Helper()
	asked := []string{}
	return func(command string, req molten.LearningRequest, out any) error {
		asked = append(asked, command+" "+req.Workflow+" "+req.Id)
		answer, ok := answers[command]
		if !ok {
			t.Fatalf("unexpected command %s", command)
		}
		if err, isErr := answer.(error); isErr {
			return err
		}
		return utilfn.ReUnmarshal(out, answer)
	}, &asked
}

func sampleLearned() molten.LearningDefaults {
	return molten.LearningDefaults{
		Workflow: "pipeline-setup",
		Prefill: []molten.LearningItem{
			{Id: "correction:merge", Kind: molten.LearningKindCorrection, Key: "merge", Value: "squash", Proposed: "merge", Seen: 2, Confidence: "medium", Source: molten.LearningSource{By: "view", Run: "project-a"}},
			{Id: "answer:apptype", Kind: molten.LearningKindAnswer, Key: "apptype", Value: "desktop", Seen: 1, Confidence: "low", Source: molten.LearningSource{By: "agent"}},
		},
		Folded: []molten.LearningItem{{Id: "skip:template", Kind: molten.LearningKindSkip, Key: "template", Seen: 3, Confidence: "high"}},
	}
}

func TestMoltenLearnDefaultsText(t *testing.T) {
	call, asked := fakeLearn(t, map[string]any{molten.LearningDefaultsCommand: sampleLearned()})
	var out bytes.Buffer
	if err := runMoltenLearnDefaults(call, "pipeline-setup", false, &out); err != nil {
		t.Fatal(err)
	}
	if len(*asked) != 1 || (*asked)[0] != molten.LearningDefaultsCommand+" pipeline-setup " {
		t.Fatalf("asked %v", *asked)
	}
	for _, want := range []string{
		"Learned defaults for pipeline-setup",
		"Prefill, mark it as based on the developer's earlier choices (2):",
		"- merge = squash (correction; seen 2 times, medium confidence)",
		"- apptype = desktop (answer; seen 1 time, low confidence)",
		"Fold these steps, the developer always skips them; show them folded, never remove them (1):",
		"- template (skipped in 3 runs in a row)",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
}

func TestMoltenLearnDefaultsJsonAndEmpty(t *testing.T) {
	call, _ := fakeLearn(t, map[string]any{molten.LearningDefaultsCommand: molten.LearningDefaults{Workflow: "pipeline-setup"}})
	var out bytes.Buffer
	if err := runMoltenLearnDefaults(call, "pipeline-setup", true, &out); err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("json: %v\n%s", err, out.String())
	}
	if prefill, ok := parsed["prefill"].([]any); !ok || len(prefill) != 0 {
		t.Fatalf("an empty prefill is a list: %v", parsed)
	}
	if folded, ok := parsed["folded"].([]any); !ok || len(folded) != 0 {
		t.Fatalf("an empty folded is a list: %v", parsed)
	}
	out.Reset()
	if err := runMoltenLearnDefaults(call, "pipeline-setup", false, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "Nothing learned yet for pipeline-setup") {
		t.Fatalf("empty text: %q", out.String())
	}
}

func TestMoltenLearnRecordOutput(t *testing.T) {
	item := molten.LearningItem{Id: "correction:merge", Kind: molten.LearningKindCorrection, Key: "merge", Value: "squash", Proposed: "merge", Seen: 2, Confidence: "medium"}
	call, _ := fakeLearn(t, map[string]any{molten.LearningRecordCommand: molten.LearningRecorded{Item: &item}})
	req := molten.LearningRequest{Workflow: "pipeline-setup", Kind: molten.LearningKindCorrection, Key: "merge", Value: "squash", Proposed: "merge"}
	var out bytes.Buffer
	if err := runMoltenLearnRecord(call, req, false, &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "Remembered for pipeline-setup: merge = squash, a correction of the proposed merge (seen 2 times, medium confidence).\n" {
		t.Fatalf("got %q", out.String())
	}
	out.Reset()
	if err := runMoltenLearnRecord(call, req, true, &out); err != nil || !strings.Contains(out.String(), `"value": "squash"`) {
		t.Fatalf("json: %v %s", err, out.String())
	}

	done := molten.LearningRequest{Workflow: "pipeline-setup", Kind: molten.LearningKindDone, Key: "template"}
	call, _ = fakeLearn(t, map[string]any{molten.LearningRecordCommand: molten.LearningRecorded{Cleared: true}})
	out.Reset()
	if err := runMoltenLearnRecord(call, done, false, &out); err != nil || !strings.Contains(out.String(), "no longer a skipped step") {
		t.Fatalf("done: %v %q", err, out.String())
	}
	call, _ = fakeLearn(t, map[string]any{molten.LearningRecordCommand: molten.LearningRecorded{}})
	out.Reset()
	if err := runMoltenLearnRecord(call, done, false, &out); err != nil || !strings.Contains(out.String(), "Nothing to clear") {
		t.Fatalf("done on a step never skipped: %v %q", err, out.String())
	}
}

func TestMoltenLearnListAndForget(t *testing.T) {
	list := molten.LearningList{Workflows: []molten.LearningWorkflow{
		{Workflow: "pipeline-setup", Items: sampleLearned().Prefill},
		{Workflow: "morph-design", Items: []molten.LearningItem{}},
	}}
	list.Workflows[0].Items[0].Edited = true
	call, _ := fakeLearn(t, map[string]any{molten.LearningListCommand: list, molten.LearningForgetCommand: molten.LearningRecorded{Cleared: true}})
	var out bytes.Buffer
	if err := runMoltenLearnList(call, "", false, &out); err != nil {
		t.Fatal(err)
	}
	want := "pipeline-setup (2):\n" +
		"- correction:merge\tsquash (proposed: merge)\tseen 2 times, medium confidence, recorded by view in run project-a, edited by the developer\n" +
		"- answer:apptype\tdesktop\tseen 1 time, low confidence, recorded by agent\n" +
		"\n" +
		"morph-design: nothing learned yet\n"
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	out.Reset()
	if err := runMoltenLearnForget(call, "pipeline-setup", "correction:merge", false, &out); err != nil || out.String() != "Forgot correction:merge of pipeline-setup.\n" {
		t.Fatalf("forget: %v %q", err, out.String())
	}
}

func TestMoltenLearnPassesTheStoreRefusalOn(t *testing.T) {
	refusal := errors.New(`unknown workflow "nope": the workflows that learn are pipeline-setup, morph-design`)
	call, _ := fakeLearn(t, map[string]any{molten.LearningDefaultsCommand: refusal})
	var out bytes.Buffer
	if err := runMoltenLearnDefaults(call, "nope", false, &out); err != refusal || out.Len() != 0 {
		t.Fatalf("the refusal reaches the caller untouched: %v %q", err, out.String())
	}
}

func TestMoltenLearnHasItsFourCommands(t *testing.T) {
	names := []string{}
	for _, c := range moltenLearnCmd.Commands() {
		names = append(names, c.Name())
	}
	got := strings.Join(names, ",")
	for _, want := range []string{"defaults", "list", "record", "forget"} {
		if !strings.Contains(got, want) {
			t.Fatalf("molten learn lacks %s: %s", want, got)
		}
	}
	if len(names) != 4 {
		t.Fatalf("agents cannot edit a value nor reset a workflow: %v", names)
	}
}
