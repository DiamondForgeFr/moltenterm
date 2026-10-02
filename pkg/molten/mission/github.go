// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The GitHub side of a project, read through the user's own gh (DS-MC-004): Moltenterm stores no token. The JSON
// fields are gh's, passed through untouched, so the panels read them as Notulia's Dev › CI does.

const prFields = "number,title,body,headRefName,baseRefName,isDraft,createdAt,updatedAt,url,mergeStateStatus,statusCheckRollup,closingIssuesReferences"
const runFields = "databaseId,workflowName,event,status,conclusion,headBranch,headSha,displayTitle,createdAt,updatedAt,url"
const releaseFields = "tagName,name,isDraft,isPrerelease,isLatest,publishedAt,createdAt"
const maxWorkflowFileBytes = 256 * 1024

const (
	GithubStateOk        = "ok"
	GithubStateNoGh      = "nogh"
	GithubStateLoggedOut = "loggedout"
	GithubStateNoRepo    = "norepo"
	GithubStateError     = "error"
)

type WorkflowFile struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type GithubSnapshot struct {
	State      string          `json:"state"`
	Message    string          `json:"message,omitempty"`
	Repo       string          `json:"repo,omitempty"`
	Url        string          `json:"url,omitempty"`
	Prs        json.RawMessage `json:"prs,omitempty"`
	Runs       json.RawMessage `json:"runs,omitempty"`
	Releases   json.RawMessage `json:"releases,omitempty"`
	Milestones json.RawMessage `json:"milestones,omitempty"`
	Workflows  []WorkflowFile  `json:"workflows"`
	// Sections that failed while the others worked, by name.
	Errors map[string]string `json:"errors,omitempty"`
}

// ReadWorkflowFiles reads `.github/workflows/*.yml|yaml` from the project folder: the scheduled jobs and their crons
// come from there, not from GitHub.
func ReadWorkflowFiles(dir string) []WorkflowFile {
	files := []WorkflowFile{}
	entries, err := os.ReadDir(filepath.Join(dir, ".github", "workflows"))
	if err != nil {
		return files
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !(strings.HasSuffix(name, ".yml") || strings.HasSuffix(name, ".yaml")) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, ".github", "workflows", name))
		if err != nil || len(data) > maxWorkflowFileBytes {
			continue
		}
		files = append(files, WorkflowFile{Name: name, Text: string(data)})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files
}

func ghJson(ctx context.Context, run Runner, dir string, args ...string) (json.RawMessage, error) {
	out, err := run(ctx, dir, "gh", args...)
	if err != nil {
		return nil, err
	}
	if !json.Valid(out) {
		return nil, errors.New("gh " + strings.Join(args[:min(2, len(args))], " ") + ": unreadable answer")
	}
	return json.RawMessage(out), nil
}

func isLoggedOutError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "gh auth login") || strings.Contains(msg, "not logged") || strings.Contains(msg, "authentication")
}

// CollectGithub reads the open pull requests, recent runs, releases and open milestones of the folder's GitHub
// repository. The state says why nothing could be read (gh missing, logged out, not a GitHub repository).
func CollectGithub(ctx context.Context, run Runner, dir string) *GithubSnapshot {
	snap := &GithubSnapshot{State: GithubStateOk, Workflows: ReadWorkflowFiles(dir), Errors: map[string]string{}}
	repo, err := ghJson(ctx, run, dir, "repo", "view", "--json", "nameWithOwner,url")
	if err != nil {
		var missing *MissingProgramError
		switch {
		case errors.As(err, &missing):
			snap.State = GithubStateNoGh
		case isLoggedOutError(err):
			snap.State = GithubStateLoggedOut
		case strings.Contains(strings.ToLower(err.Error()), "no git remotes") || strings.Contains(strings.ToLower(err.Error()), "none of the git remotes"):
			snap.State = GithubStateNoRepo
		default:
			snap.State = GithubStateError
		}
		snap.Message = err.Error()
		return snap
	}
	var info struct {
		NameWithOwner string `json:"nameWithOwner"`
		Url           string `json:"url"`
	}
	json.Unmarshal(repo, &info)
	snap.Repo = info.NameWithOwner
	snap.Url = info.Url
	sections := []struct {
		name   string
		target *json.RawMessage
		args   []string
	}{
		{"prs", &snap.Prs, []string{"pr", "list", "--state", "open", "--limit", "50", "--json", prFields}},
		{"runs", &snap.Runs, []string{"run", "list", "--limit", "30", "--json", runFields}},
		{"releases", &snap.Releases, []string{"release", "list", "--limit", "30", "--json", releaseFields}},
		{"milestones", &snap.Milestones, []string{"api", "repos/{owner}/{repo}/milestones?state=open&per_page=20"}},
	}
	for _, section := range sections {
		out, err := ghJson(ctx, run, dir, section.args...)
		if err != nil {
			snap.Errors[section.name] = err.Error()
			continue
		}
		*section.target = out
	}
	return snap
}
