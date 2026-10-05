// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The release runner, driven from outside (#230): frontend/moltenterm-shell/mission/release-e2e.test.ts sends one
// JSON request per line on stdin and reads one answer per line prefixed with releaseDriverPrefix, so the Timeline's
// own sequencing (release-run.ts) chooses every step this real runner runs on a fixture. Skipped unless
// MOLTEN_RELEASE_DRIVER is set.

const releaseDriverPrefix = "DRIVER "

type releaseDriverRequest struct {
	Op      string `json:"op"`
	Variant string `json:"variant,omitempty"`
	Channel string `json:"channel,omitempty"`
	Tag     string `json:"tag,omitempty"`
	Step    string `json:"step,omitempty"`
	Text    string `json:"text,omitempty"`
}

type releaseDriverAnswer struct {
	Error    string           `json:"error,omitempty"`
	Dir      string           `json:"dir,omitempty"`
	Pipeline *molten.Pipeline `json:"pipeline,omitempty"`
	Facts    *ReleaseFacts    `json:"facts,omitempty"`
	Run      *RunRecord       `json:"run,omitempty"`
	Log      string           `json:"log,omitempty"`
	Notes    string           `json:"notes,omitempty"`
}

func TestReleaseDriver(t *testing.T) {
	if os.Getenv("MOLTEN_RELEASE_DRIVER") == "" {
		t.Skip("driven by release-e2e.test.ts")
	}
	var r *Runs
	var dir string
	finish := func(rec RunRecord) releaseDriverAnswer {
		done := waitRun(t, r, dir, rec.Id)
		chunk, _ := r.ReadLog(dir, done.Id, 0)
		return releaseDriverAnswer{Run: &done, Log: chunk.Text}
	}
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		var req releaseDriverRequest
		var ans releaseDriverAnswer
		if err := json.Unmarshal(in.Bytes(), &req); err != nil {
			ans.Error = err.Error()
		}
		var err error
		switch req.Op {
		case "fixture":
			r, dir = makeNotuliaFixture(t, req.Variant)
			ans.Dir = dir
			ans.Pipeline = molten.ValidatePipeline(dir).Pipeline
		case "start":
			var res ReleaseStartResult
			res, err = r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: req.Channel, Tag: req.Tag})
			if err == nil && res.Untrusted != nil {
				r.GrantTrust(dir, res.Untrusted.Hash)
				res, err = r.StartRelease(ReleaseStartRequest{Dir: dir, Channel: req.Channel, Tag: req.Tag})
			}
			if err == nil && res.Run != nil {
				ans = finish(*res.Run)
			}
		case "facts":
			var facts ReleaseFacts
			facts, err = r.ReleaseFactsOf(dir)
			ans.Facts = &facts
		case "step":
			var res RunResult
			res, err = r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: req.Tag, Step: req.Step})
			if err == nil && res.Run != nil {
				ans = finish(*res.Run)
			}
		case "notes":
			var notes ReleaseNotes
			notes, err = r.ReadReleaseNotes(dir, req.Tag)
			ans.Notes = notes.Text
		case "savenotes":
			err = r.SaveReleaseNotes(dir, req.Tag, req.Text)
		case "fail":
			err = os.WriteFile(filepath.Join(dir, ".fail-"+req.Step), nil, 0644)
		case "end":
			err = r.EndRelease(dir)
		case "quit":
			return
		default:
			err = fmt.Errorf("unknown op %q", req.Op)
		}
		if err != nil {
			ans.Error = err.Error()
		}
		data, _ := json.Marshal(ans)
		fmt.Printf("%s%s\n", releaseDriverPrefix, data)
	}
}
