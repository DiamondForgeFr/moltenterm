// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
)

type ReposRequest struct {
	Dir string `json:"dir"`
}

type ReposAnswer struct {
	Dir   string   `json:"dir"`
	Repos []string `json:"repos"`
	// Self: the folder is itself a repository, so it is the only one listed.
	Self bool `json:"self"`
}

// FindRepos lists the Git repositories of a project's folder (FR-SHELL-105): the choices of its Code repository.
func FindRepos(req ReposRequest) (ReposAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return ReposAnswer{}, err
	}
	repos := molten.FindRepositories(req.Dir)
	return ReposAnswer{Dir: req.Dir, Repos: repos, Self: len(repos) == 1 && repos[0] == req.Dir}, nil
}
