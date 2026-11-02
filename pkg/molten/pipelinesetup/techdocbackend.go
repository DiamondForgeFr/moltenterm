// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Where the technical documentation goes (FR-MC-043): a documentation backend behind one interface, or the repository
// file carried in the pipeline's pull request when no backend is declared or reachable. The document is built once
// (BuildTechDoc); a backend only reads and writes it.

const (
	TechDocBackendRepository  = "repository"
	TechDocBackendSaaSFoundry = "saasfoundry"

	// The answer `sf srs techdoc … --json` is expected to print (asked on DiamondForgeFr/SaasFoundryAI#1112).
	SfTechDocSchema = 1
)

var sfTechDocActionRegex = regexp.MustCompile(`(?m)^\s+techdoc\b`)

// TechDocPage is a backend's page: its address and its body ("" when it does not exist yet).
type TechDocPage struct {
	Url      string `json:"url"`
	Markdown string `json:"markdown"`
}

type TechDocBackend interface {
	Name() string
	Available(ctx context.Context, dir string) bool
	Read(ctx context.Context, dir string, topic string) (TechDocPage, error)
	Write(ctx context.Context, dir string, topic string, title string, markdown string) (TechDocPage, error)
}

// SaaSFoundryDocBackend writes the project's documentation where its SaaSFoundryAI manifest declares it (Notion today),
// in the Technical documentation section next to the SRS, through the project's own CLI: MoltenTerm never holds the
// backend's token.
type SaaSFoundryDocBackend struct {
	Run Runner
}

func (SaaSFoundryDocBackend) Name() string { return TechDocBackendSaaSFoundry }

// sfDocsDeclared: the manifest declares an SRS or a documentation tool.
func sfDocsDeclared(dir string) bool {
	var sf struct {
		Tools *struct {
			Srs *struct {
				Enabled bool   `json:"enabled"`
				Backend string `json:"backend"`
			} `json:"srs"`
			Docs *struct {
				Name string `json:"name"`
			} `json:"docs"`
		} `json:"tools"`
	}
	if !readJson(filepath.Join(dir, molten.ProjectSaaSFoundryFile), &sf) || sf.Tools == nil {
		return false
	}
	return (sf.Tools.Srs != nil && sf.Tools.Srs.Enabled && sf.Tools.Srs.Backend != "") || (sf.Tools.Docs != nil && sf.Tools.Docs.Name != "")
}

// Available: the manifest declares a backend and the CLI lists the techdoc action (`sf srs help`; an unknown action's
// --help prints the generic usage and succeeds, so it proves nothing).
func (b SaaSFoundryDocBackend) Available(ctx context.Context, dir string) bool {
	if b.Run == nil || !sfDocsDeclared(dir) {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, sfTimeout)
	defer cancel()
	out, err := b.Run(ctx, dir, "sf", "srs", "help")
	return err == nil && sfTechDocActionRegex.Match(out)
}

type sfTechDocAnswer struct {
	Schema   int    `json:"schema"`
	Url      string `json:"url"`
	Markdown string `json:"markdown"`
}

func parseSfTechDoc(out []byte) (TechDocPage, error) {
	var answer sfTechDocAnswer
	if err := json.Unmarshal(out, &answer); err != nil {
		return TechDocPage{}, fmt.Errorf("sf srs techdoc: unreadable answer: %w", err)
	}
	if answer.Schema != SfTechDocSchema {
		return TechDocPage{}, fmt.Errorf("sf srs techdoc: schema %d is not supported (expected %d)", answer.Schema, SfTechDocSchema)
	}
	if answer.Url != "" && !strings.HasPrefix(answer.Url, "https://") {
		return TechDocPage{}, fmt.Errorf("sf srs techdoc: not a web address: %q", answer.Url)
	}
	if len(answer.Markdown) > maxTechDocBytes {
		return TechDocPage{}, fmt.Errorf("sf srs techdoc: the page is too large")
	}
	return TechDocPage{Url: answer.Url, Markdown: answer.Markdown}, nil
}

func (b SaaSFoundryDocBackend) Read(ctx context.Context, dir string, topic string) (TechDocPage, error) {
	ctx, cancel := context.WithTimeout(ctx, sfTimeout)
	defer cancel()
	out, err := b.Run(ctx, dir, "sf", "srs", "techdoc", "read", "--topic", topic, "--json")
	if err != nil {
		return TechDocPage{}, err
	}
	return parseSfTechDoc(out)
}

// Write hands the document over as a file of MoltenTerm's own (0600, removed after): never on the command line.
func (b SaaSFoundryDocBackend) Write(ctx context.Context, dir string, topic string, title string, markdown string) (TechDocPage, error) {
	if len(markdown) > maxTechDocBytes {
		return TechDocPage{}, fmt.Errorf("the document is too large")
	}
	tmp, err := os.CreateTemp("", "molten-techdoc-*.md")
	if err != nil {
		return TechDocPage{}, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(markdown); err != nil {
		tmp.Close()
		return TechDocPage{}, err
	}
	if err := tmp.Close(); err != nil {
		return TechDocPage{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, sfTimeout)
	defer cancel()
	out, err := b.Run(ctx, dir, "sf", "srs", "techdoc", "write", "--topic", topic, "--title", title, "--file", tmp.Name(), "--json")
	if err != nil {
		return TechDocPage{}, err
	}
	page, err := parseSfTechDoc(out)
	page.Markdown = markdown
	return page, err
}
