// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Draft providers (DS-MC-031): a SaaSFoundryAI-managed project is drafted by its own CLI when it offers
// `sf pipeline draft` (DiamondForgeFr/SaasFoundryAI#1091), which knows the project's profile, stack and generated
// workflows; every other project, and a SaaSFoundryAI one whose CLI does not offer it yet, by MoltenTerm's detection.
// Both feed the same review.

const (
	ProviderMoltenTerm  = "moltenterm"
	ProviderSaaSFoundry = "saasfoundry"

	SfDraftSchema = 1

	sfTimeout = 60 * time.Second
)

// Runner runs a program in a folder and returns its standard output.
type Runner func(ctx context.Context, dir string, name string, args ...string) ([]byte, error)

type Provider interface {
	Name() string
	Available(ctx context.Context, dir string) bool
	Draft(ctx context.Context, dir string, kind string) (*ProviderDraft, error)
}

// ProviderDraft is what a provider proposes: the kind, the blocks, each step's source, its warnings.
type ProviderDraft struct {
	Provider string   `json:"provider"`
	Kind     string   `json:"kind"`
	Proposal Proposal `json:"proposal"`
	Warnings []string `json:"warnings"`
}

// The JSON `sf pipeline draft --json` is expected to print (asked on DiamondForgeFr/SaasFoundryAI#1091); only this
// adapter reads it.
type sfDraftAnswer struct {
	Schema   int    `json:"schema"`
	Kind     string `json:"kind"`
	Fragment struct {
		Versions *molten.PipelineVersions     `json:"versions"`
		Release  *molten.PipelineRelease      `json:"release"`
		Steps    []molten.PipelineAdapterStep `json:"steps"`
	} `json:"fragment"`
	Sources  map[string]string `json:"sources"`
	Warnings []string          `json:"warnings"`
}

type SaaSFoundryProvider struct {
	Run Runner
}

func (p SaaSFoundryProvider) Name() string { return ProviderSaaSFoundry }

// Available: the project is SaaSFoundryAI-managed and its CLI documents `pipeline draft`.
func (p SaaSFoundryProvider) Available(ctx context.Context, dir string) bool {
	if !fileExists(filepath.Join(dir, molten.ProjectSaaSFoundryFile)) || p.Run == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, sfTimeout)
	defer cancel()
	out, err := p.Run(ctx, dir, "sf", "pipeline", "draft", "--help")
	return err == nil && strings.Contains(string(out), "--json")
}

func (p SaaSFoundryProvider) Draft(ctx context.Context, dir string, kind string) (*ProviderDraft, error) {
	ctx, cancel := context.WithTimeout(ctx, sfTimeout)
	defer cancel()
	args := []string{"pipeline", "draft", "--json"}
	if kind != "" {
		args = append(args, "--kind", kind)
	}
	out, err := p.Run(ctx, dir, "sf", args...)
	if err != nil {
		return nil, err
	}
	return parseSfDraft(out)
}

// sourceKey turns the CLI's step paths ("release.rc[0]", "steps[1]") into the proposal's ("rc/<id>", "steps/<id>").
func sourceKey(path string, proposal Proposal) string {
	var list string
	var index int
	if _, err := fmt.Sscanf(strings.ReplaceAll(strings.ReplaceAll(path, "[", " "), "]", ""), "%s %d", &list, &index); err != nil {
		return path
	}
	switch list {
	case "release.rc":
		if proposal.Release != nil && index >= 0 && index < len(proposal.Release.Rc) {
			return ChannelRc + "/" + proposal.Release.Rc[index].Id
		}
	case "release.public":
		if proposal.Release != nil && index >= 0 && index < len(proposal.Release.Public) {
			return ChannelPublic + "/" + proposal.Release.Public[index].Id
		}
	case "steps":
		if index >= 0 && index < len(proposal.Steps) {
			return "steps/" + proposal.Steps[index].Id
		}
	}
	return path
}

func parseSfDraft(out []byte) (*ProviderDraft, error) {
	var answer sfDraftAnswer
	if err := json.Unmarshal(out, &answer); err != nil {
		return nil, fmt.Errorf("sf pipeline draft: unreadable answer: %w", err)
	}
	if answer.Schema != SfDraftSchema {
		return nil, fmt.Errorf("sf pipeline draft: schema %d is not supported (expected %d)", answer.Schema, SfDraftSchema)
	}
	if answer.Kind != KindOnPremise && answer.Kind != KindSaas {
		return nil, fmt.Errorf("sf pipeline draft: unknown kind %q", answer.Kind)
	}
	proposal := Proposal{Release: answer.Fragment.Release, Versions: answer.Fragment.Versions, Steps: answer.Fragment.Steps, Sources: map[string]Source{}}
	for path, text := range answer.Sources {
		proposal.Sources[sourceKey(path, proposal)] = Source{Code: "provider", Detail: text}
	}
	warnings := answer.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	return &ProviderDraft{Provider: ProviderSaaSFoundry, Kind: answer.Kind, Proposal: proposal, Warnings: warnings}, nil
}

// DetectionProvider is MoltenTerm's own: the repository's facts and the templates.
type DetectionProvider struct {
	// The facts the setup already read (the remote ones included); nil reads the files again.
	Facts *Facts
}

func (DetectionProvider) Name() string { return ProviderMoltenTerm }

func (DetectionProvider) Available(context.Context, string) bool { return true }

func (d DetectionProvider) Draft(_ context.Context, dir string, kind string) (*ProviderDraft, error) {
	var f Facts
	if d.Facts != nil {
		f = *d.Facts
	} else {
		f = Detect(dir)
	}
	o := DefaultOptions(f)
	if kind != "" {
		o.Kind = kind
	}
	report := molten.ValidatePipeline(dir)
	return &ProviderDraft{Provider: ProviderMoltenTerm, Kind: o.Kind, Proposal: Build(f, o, report.Pipeline), Warnings: []string{}}, nil
}
