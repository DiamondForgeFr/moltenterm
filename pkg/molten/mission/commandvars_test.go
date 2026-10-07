// Copyright 2026, Moltenterm
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

var hostileValues = []string{
	"1.0.0; touch PWNED",
	"$(touch PWNED)",
	"`touch PWNED`",
	"1.0.0\ntouch PWNED",
	"1.0.0' ; touch PWNED ; '",
	`1.0.0" ; touch PWNED ; "`,
	"--option",
	"-1.0.0",
	"1.0.0 && touch PWNED",
	"1.0.0|touch PWNED",
}

func TestCommandVarsRefuseHostileValues(t *testing.T) {
	for _, value := range hostileValues {
		for name, vars := range map[string]CommandVars{
			"version": {Version: value},
			"tag":     {Tag: value},
			"branch":  {Branch: value},
		} {
			if got, err := expandCommand("echo {version} {tag} {branch}", vars); err == nil {
				t.Errorf("%s %q must be refused, expanded to %q", name, value, got)
			}
		}
	}
	for _, tag := range []string{"v1.0.0..2", "v1.0.0.lock", "refs//x", "a/.b", "x/", "v1.0.0."} {
		if _, err := expandCommand("{tag}", CommandVars{Tag: tag}); err == nil {
			t.Errorf("tag %q breaks git's ref rules and must be refused", tag)
		}
	}
}

func TestCommandVarsKeepNormalValues(t *testing.T) {
	got, err := expandCommand("r {version} {tag} {branch}", CommandVars{Version: "1.0.0-2", Tag: "v1.0.0-2", Branch: "feature/306-quote_x.y"})
	if err != nil || got != "r 1.0.0-2 v1.0.0-2 feature/306-quote_x.y" {
		t.Fatalf("expand: %q %v", got, err)
	}
}

func TestReleaseCommandsRefuseHostileValues(t *testing.T) {
	step := molten.PipelineStep{Id: "bump"}
	step.Run = "echo {tag}"
	if _, err := preparationCommand([]molten.PipelineStep{step}, "1.0.0", "v1.0.0; touch PWNED", "develop"); err == nil {
		t.Fatal("a hostile tag must be refused")
	}
	if _, err := expandRelease("echo {tag}", "1.0.0", "v1.0.0", "$(id)"); err == nil {
		t.Fatal("a hostile branch must be refused")
	}
}

func startWithTrust(t *testing.T, r *Runs, req RunRequest) (RunResult, error) {
	t.Helper()
	res, err := r.Start(req)
	if err != nil || res.Untrusted == nil {
		return res, err
	}
	if err := r.GrantTrust(req.Dir, res.Untrusted.Hash); err != nil {
		t.Fatal(err)
	}
	return r.Start(req)
}

func TestStartRefusesHostileVersionBeforeRunningAnything(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "PWNED")
	r, dir := makeRunsFixture(t, `{"id":"gold","title":"Gold","run":"echo {version}","artifact":"out"}`)
	for _, value := range hostileValues {
		res, err := startWithTrust(t, r, RunRequest{Dir: dir, Kind: RunKindBuild, Id: "gold", Version: value})
		if err == nil {
			t.Errorf("version %q must be refused, got %+v", value, res)
		}
	}
	if len(r.List(dir)) != 0 {
		t.Fatalf("a refused value must leave no run: %+v", r.List(dir))
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("something extra ran")
	}
}

func TestStartRunsNormalVersionAndBranch(t *testing.T) {
	r, dir := makeRunsFixture(t, `{"id":"gold","title":"Gold","run":"echo v={version} b={branch} t={tag}","artifact":"out"}`)
	res, err := startWithTrust(t, r, RunRequest{Dir: dir, Kind: RunKindBuild, Id: "gold", Version: "1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	rec := waitRun(t, r, dir, res.Run.Id)
	if rec.Command != "echo v=1.2.3 b=develop t=v1.2.3" {
		t.Fatalf("command %q", rec.Command)
	}
}
