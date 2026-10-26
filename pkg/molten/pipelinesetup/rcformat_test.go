// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The candidate format (#1155): the setup writes versions.rcformat for X.Y.Z-rc.N only, keeps a declared one, reads
// the workflows an rc.N tag starts, and documents the form.
func TestSetupCarriesTheCandidateFormat(t *testing.T) {
	if rc, public := sampleTags("v", ""); rc != "v1.2.3-1" || public != "v1.2.3" {
		t.Fatalf("numeric: %s %s", rc, public)
	}
	if rc, _ := sampleTags("release-", RcFormatRcDot); rc != "release-1.2.3-rc.1" {
		t.Fatalf("rcdot: %s", rc)
	}

	f := Facts{TagPrefix: "v"}
	o := DefaultOptions(f)
	if o.RcFormat != RcFormatNumeric {
		t.Fatalf("default: %q", o.RcFormat)
	}
	if v := proposedVersions(f, o, nil); v != nil && v.RcFormat != "" {
		t.Fatalf("the default stays implicit: %+v", v)
	}
	o.RcFormat = RcFormatRcDot
	if v := proposedVersions(f, o, nil); v == nil || v.RcFormat != RcFormatRcDot {
		t.Fatalf("rcdot written: %+v", v)
	}

	current := &molten.Pipeline{Versions: &molten.PipelineVersions{RcFormat: RcFormatRcDot}}
	declared := Facts{TagPrefix: "v", RcFormat: RcFormatRcDot}
	o = DefaultOptions(declared)
	if o.RcFormat != RcFormatRcDot || proposedVersions(declared, o, current) != nil {
		t.Fatalf("a declared rcdot is kept: %+v", o)
	}
	o.RcFormat = RcFormatNumeric
	if v := proposedVersions(declared, o, current); v == nil || v.RcFormat != "" {
		t.Fatalf("back to numeric drops the field: %+v", v)
	}

	in := TechDocInput{Pipeline: current, Facts: declared}
	if got := rcPatternOf(in); got != "X.Y.Z-rc.N" {
		t.Fatalf("techdoc: %s", got)
	}
	if got := rcPatternOf(TechDocInput{}); got != "X.Y.Z-N" {
		t.Fatalf("techdoc default: %s", got)
	}
}

func TestAnRcDotTagStartsTheCandidateWorkflows(t *testing.T) {
	wf := Workflow{File: "rc.yml", Push: true, Tags: []string{"v*-rc.*"}}
	f := Facts{TagPrefix: "v", Workflows: []Workflow{wf}}
	if files, _ := tagWorkflows(f, ChannelRc, "v"); len(files) != 0 {
		t.Fatalf("a -N candidate does not start rc.yml: %v", files)
	}
	f.RcFormat = RcFormatRcDot
	if files, _ := tagWorkflows(f, ChannelRc, "v"); len(files) != 1 || !strings.HasSuffix(files[0], "rc.yml") {
		t.Fatalf("an rc.N candidate starts rc.yml: %v", files)
	}
}
