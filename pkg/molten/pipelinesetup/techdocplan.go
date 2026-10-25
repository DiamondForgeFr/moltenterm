// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
)

// The technical documentation in the setup's flow (FR-MC-043): step 3 and the update dialog preview it (TechDoc),
// Write and Update rebuild it from the merged pipeline, never from text the window sends, and carry it in the pull
// request, or hand it to the backend once the pull request is open.

const PrStepDoc = "doc"

type TechDocRequest struct {
	Dir string `json:"dir"`
	// The proposed .molten/project.json the document is built from.
	Text string `json:"text"`
	// write (a setup) or update.
	Kind string `json:"kind,omitempty"`
}

type TechDocPlan struct {
	Backend string `json:"backend"`
	Topic   string `json:"topic"`
	Title   string `json:"title"`
	// The repository file, or the backend page's address ("" before it exists).
	Path string `json:"path,omitempty"`
	Url  string `json:"url,omitempty"`
	// The document as it is now ("" when there is none) and as the pull request would leave it.
	Current  string `json:"current"`
	Proposed string `json:"proposed"`
	// Why the backend was not used, or why nothing could be built.
	Warnings []string `json:"warnings"`
}

// TechDocLink is where the Release menu's "How this project ships" opens the document: a file of the folder opened,
// or a web page (the backend's, or the file on GitHub when it is not checked out yet).
type TechDocLink struct {
	Backend string `json:"backend"`
	Path    string `json:"path,omitempty"`
	Url     string `json:"url,omitempty"`
}

// techDocBackends: the backends to try, in order; nil: SaaSFoundryAI's.
func (s *Setup) techDocBackends() []TechDocBackend {
	if s.DocBackends != nil {
		return s.DocBackends
	}
	return []TechDocBackend{SaaSFoundryDocBackend{Run: s.Run}}
}

// docBackend: the first available backend; nil: the repository file. A patch carries the file, never a backend write.
func (s *Setup) docBackend(ctx context.Context, dir string, mode string) TechDocBackend {
	if mode == PrModePatch {
		return nil
	}
	for _, b := range s.techDocBackends() {
		if b.Available(ctx, dir) {
			return b
		}
	}
	return nil
}

// gitAuthor: the name the pull request's commit is made with ("Name <mail> date zone").
func (s *Setup) gitAuthor(ctx context.Context, dir string) string {
	out, err := s.git(ctx, dir, "var", "GIT_AUTHOR_IDENT")
	if err != nil {
		return ""
	}
	name, _, _ := strings.Cut(strings.TrimSpace(string(out)), " <")
	return strings.TrimSpace(name)
}

func (s *Setup) githubRepo(ctx context.Context, dir string) string {
	if !onGithub(dir) {
		return ""
	}
	out, err := s.git(ctx, dir, "config", "--get", "remote.origin.url")
	if err != nil {
		return ""
	}
	return release.GithubRepo(string(out))
}

// committedTechDoc: the repository file at the base commit, else the working copy's when there is no commit.
func (s *Setup) committedTechDoc(ctx context.Context, dir string, b *baseFiles) string {
	if b != nil && b.Commit != "" {
		data, _ := s.committedFile(ctx, dir, b.Commit, TechDocPath)
		return string(data)
	}
	path := filepath.Join(dir, filepath.FromSlash(TechDocPath))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxTechDocBytes {
		return ""
	}
	data, _ := os.ReadFile(path)
	return string(data)
}

type techDocBuild struct {
	plan    TechDocPlan
	backend TechDocBackend
	input   TechDocInput
}

// buildTechDoc: where the document goes, as it is there, and as the given pipeline makes it. The facts are read again
// (workflows, protection), as the draft does.
func (s *Setup) buildTechDoc(ctx context.Context, dir string, b *baseFiles, text []byte, kind string, branch string, mode string) (*techDocBuild, error) {
	report := pipelineReport(dir, text)
	if !report.Valid || report.Pipeline == nil {
		return nil, fmt.Errorf("the pipeline is not valid: %s", strings.Join(report.Errors, "; "))
	}
	f := DetectWith(dir, report)
	ReadRemoteFacts(ctx, s.Run, dir, &f)
	build := &techDocBuild{plan: TechDocPlan{Backend: TechDocBackendRepository, Topic: TechDocTopicRelease, Title: TechDocTitle, Path: TechDocPath, Warnings: []string{}}}
	if backend := s.docBackend(ctx, dir, mode); backend != nil {
		page, err := backend.Read(ctx, dir, TechDocTopicRelease)
		if err == nil {
			build.backend = backend
			build.plan.Backend, build.plan.Path, build.plan.Url, build.plan.Current = backend.Name(), "", page.Url, page.Markdown
		} else {
			build.plan.Warnings = append(build.plan.Warnings, fmt.Sprintf("%s: %v", backend.Name(), err))
		}
	}
	if build.backend == nil {
		build.plan.Current = s.committedTechDoc(ctx, dir, b)
	}
	change := TechDocChange{Date: time.Now().Format("2006-01-02"), Kind: TechDocChangeSetup, Author: s.gitAuthor(ctx, dir), Branch: branch, Template: TemplateVersion}
	if kind == PrKindUpdate {
		change.Kind = TechDocChangeUpdate
	}
	build.input = TechDocInput{Pipeline: report.Pipeline, Facts: f, Change: change, Previous: build.plan.Current, Repo: s.githubRepo(ctx, dir)}
	build.plan.Proposed = BuildTechDoc(build.input)
	if len(build.plan.Proposed) > maxTechDocBytes {
		return nil, errors.New("the technical documentation is too large")
	}
	return build, nil
}

// TechDoc previews the document for step 3 and the update dialog; nothing is written.
func (s *Setup) TechDoc(ctx context.Context, req TechDocRequest) (TechDocPlan, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return TechDocPlan{}, err
	}
	if len(req.Text) > maxPipelineBytes {
		return TechDocPlan{}, fmt.Errorf("the proposed %s is too large", molten.ProjectPipelineFile)
	}
	kind := PrKindWrite
	if req.Kind == PrKindUpdate {
		kind = PrKindUpdate
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return TechDocPlan{}, err
	}
	merged, _, err := MergeOwned(b.Pipeline, []byte(req.Text), nameOf(dir, b.Pipeline))
	if err != nil {
		return TechDocPlan{}, err
	}
	required, _ := ticketRequired(dir)
	ticket := ""
	if required {
		ticket = "{N}"
	}
	branch, _ := prNames(dir, kind, ticket)
	build, err := s.buildTechDoc(ctx, dir, b, merged, kind, branch, PrModePr)
	if err != nil {
		return TechDocPlan{Backend: TechDocBackendRepository, Topic: TechDocTopicRelease, Title: TechDocTitle, Path: TechDocPath, Warnings: []string{err.Error()}}, nil
	}
	return build.plan, nil
}

// techDocSteps: the job's steps, with the backend write after the pull request when a backend takes the document.
func techDocSteps(steps []string, backend TechDocBackend) []string {
	if backend == nil {
		return steps
	}
	return append(steps, PrStepDoc)
}

// withTechDoc arms the pull request's files with the document: rebuilt once the branch is known, from the pipeline the
// pull request carries; into the repository file, or for the backend once the pull request is open.
func (s *Setup) withTechDoc(dir string, b *baseFiles, current []byte, files *prFiles, kind string, mode string, backend TechDocBackend) {
	if bytes.Equal(files.files[molten.ProjectPipelineFile], current) {
		return
	}
	files.techDoc = func(ctx context.Context, branch string, files *prFiles) error {
		build, err := s.buildTechDoc(ctx, dir, b, files.files[molten.ProjectPipelineFile], kind, branch, mode)
		if err != nil {
			return err
		}
		// A backend that answered when the job started and fails now: the file keeps the document in the pull request
		// rather than losing it.
		if backend == nil || build.backend == nil {
			files.add(TechDocPath, []byte(build.plan.Proposed))
			return nil
		}
		files.afterPr = func(ctx context.Context, prUrl string) (string, error) {
			build.input.Change.PrUrl = prUrl
			page, err := build.backend.Write(ctx, dir, TechDocTopicRelease, TechDocTitle, BuildTechDoc(build.input))
			return page.Url, err
		}
		return nil
	}
}

// TechDocLinkOf: where the document of a set-up project is, for the Release menu; nil when there is none.
func (s *Setup) TechDocLinkOf(ctx context.Context, dir string, b *baseFiles) *TechDocLink {
	if backend := s.docBackend(ctx, dir, PrModePr); backend != nil {
		if page, err := backend.Read(ctx, dir, TechDocTopicRelease); err == nil && page.Url != "" {
			return &TechDocLink{Backend: backend.Name(), Url: page.Url}
		}
	}
	local := filepath.Join(dir, filepath.FromSlash(TechDocPath))
	if info, err := os.Lstat(local); err == nil && info.Mode().IsRegular() {
		return &TechDocLink{Backend: TechDocBackendRepository, Path: local}
	}
	if b == nil || b.Commit == "" {
		return nil
	}
	if data, _ := s.committedFile(ctx, dir, b.Commit, TechDocPath); data == nil {
		return nil
	}
	repo := s.githubRepo(ctx, dir)
	if repo == "" {
		return nil
	}
	host, path := "github.com", repo
	if parts := strings.Split(repo, "/"); len(parts) == 3 {
		host, path = parts[0], parts[1]+"/"+parts[2]
	}
	return &TechDocLink{Backend: TechDocBackendRepository, Url: "https://" + host + "/" + path + "/blob/" + b.Trunk + "/" + TechDocPath}
}
