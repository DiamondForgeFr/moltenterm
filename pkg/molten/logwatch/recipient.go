// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Who is asked to look (FR-BOSS-012 AC9): the lead agent of MoltenTerm's own repository, the project whose origin is
// MoltenTerm's GitHub repository. A running agent that holds a first name locked for that project (FR-CONT-014) is its
// lead; else the only agent working at that project's root (the others work in worktrees, for their own tickets). With
// none or several, the developer picks, MoltenTerm's agents listed first.

// maxOffered: the agents the developer picks among.
const maxOffered = 20

// Agent is a running local agent, as the choice reads it.
type Agent struct {
	BlockId     string
	FirstName   string
	AgentName   string
	Workspace   string
	WorkspaceId string
	Folder      string
	ProjectDir  string
}

// Candidate is an agent the developer may pick, as the window lists it.
type Candidate struct {
	BlockId   string `json:"blockid"`
	FirstName string `json:"firstname"`
	AgentName string `json:"agentname,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	Project   string `json:"project,omitempty"`
	// MoltenTerm: the agent works in MoltenTerm's own repository.
	MoltenTerm bool `json:"moltenterm,omitempty"`
}

var githubRemoteRe = regexp.MustCompile(`(?i)github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$`)

// GithubRepoOf reads "owner/repo" from an origin URL, lower case, "" when it is not a GitHub URL.
func GithubRepoOf(url string) string {
	m := githubRemoteRe.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1] + "/" + m[2])
}

func samePath(a string, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func projectName(dir string) string {
	if dir == "" {
		return ""
	}
	return filepath.Base(filepath.Clean(dir))
}

func candidateOf(a Agent, moltenterm bool) Candidate {
	return Candidate{BlockId: a.BlockId, FirstName: a.FirstName, AgentName: a.AgentName, Workspace: a.Workspace,
		Project: projectName(a.ProjectDir), MoltenTerm: moltenterm}
}

// chooseRecipient answers the agent to ask, or none and the agents the developer picks among. isMoltenTerm says whether
// a project folder is MoltenTerm's repository; locks are the locked first names, in the order they were locked.
func chooseRecipient(agents []Agent, locks []molten.AgentNameLock, isMoltenTerm func(dir string) bool) (*Agent, []Candidate) {
	ours := map[string]bool{}
	for _, a := range agents {
		if a.ProjectDir != "" && isMoltenTerm(a.ProjectDir) {
			ours[a.BlockId] = true
		}
	}
	for _, lock := range locks {
		for i := range agents {
			a := agents[i]
			if ours[a.BlockId] && samePath(lock.Project, a.ProjectDir) && strings.EqualFold(strings.TrimSpace(a.FirstName), strings.TrimSpace(lock.Name)) {
				return &a, nil
			}
		}
	}
	var roots []Agent
	for _, a := range agents {
		if ours[a.BlockId] && samePath(a.Folder, a.ProjectDir) {
			roots = append(roots, a)
		}
	}
	if len(roots) == 1 {
		return &roots[0], nil
	}
	offer := make([]Agent, len(agents))
	copy(offer, agents)
	rank := func(a Agent) int {
		switch {
		case ours[a.BlockId] && samePath(a.Folder, a.ProjectDir):
			return 0
		case ours[a.BlockId]:
			return 1
		}
		return 2
	}
	sort.SliceStable(offer, func(i, j int) bool { return rank(offer[i]) < rank(offer[j]) })
	var out []Candidate
	for i := 0; i < len(offer) && i < maxOffered; i++ {
		out = append(out, candidateOf(offer[i], ours[offer[i].BlockId]))
	}
	return nil, out
}
