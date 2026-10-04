// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// A workspace linked to its project (FR-MC-001, DS-MC-002). The link lives on the workspace, in its meta; Moltenterm
// only reads the project and never writes in it. The pipeline itself (`.molten/project.json`) is written by the user's
// agent (FR-MC-008).

// must match the keys in frontend/moltenterm-shell/workspace-project.ts
const (
	ProjectMetaKey     = "molten:project"
	ProjectLogoMetaKey = "molten:projectlogo"
	// The project the logo was last offered for, by the rail (frontend only).
	ProjectLogoOfferMetaKey = "molten:projectlogooffer"
)

const ProjectPipelineFile = ".molten/project.json"
const ProjectSaaSFoundryFile = ".saasfoundry.json"

const projectMaxLogos = 8
const projectMaxReadmeBytes = 256 * 1024

type ProjectConventions struct {
	WorkingBranch  string            `json:"workingbranch,omitempty"`
	PrTargetBranch string            `json:"prtargetbranch,omitempty"`
	MainBranch     string            `json:"mainbranch,omitempty"`
	BranchNaming   map[string]string `json:"branchnaming,omitempty"`
	CommitPattern  string            `json:"commitpattern,omitempty"`
	RequireTicket  bool              `json:"requireticket,omitempty"`
	ProjectUrl     string            `json:"projecturl,omitempty"`
}

type ProjectInfo struct {
	Dir         string `json:"dir"`
	Name        string `json:"name"`
	Exists      bool   `json:"exists"`
	GitRoot     string `json:"gitroot,omitempty"`
	HasPipeline bool   `json:"haspipeline"`
	// Set when the pipeline file exists but cannot be read; the link still works.
	PipelineError string              `json:"pipelineerror,omitempty"`
	Harness       string              `json:"harness,omitempty"`
	Conventions   *ProjectConventions `json:"conventions,omitempty"`
}

// FindGitRoot returns the closest folder at or above dir holding a `.git` entry (a folder, or a file in a worktree).
func FindGitRoot(dir string) string {
	current := filepath.Clean(dir)
	for {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}

// ResolveProjectDir turns the folder given to `molten project link` (or the terminal's folder) into the project folder:
// the git root when the folder is inside a repository, the folder itself otherwise.
func ResolveProjectDir(arg string, cwd string) (string, error) {
	dir := arg
	if dir == "" {
		dir = cwd
	}
	if strings.HasPrefix(dir, "~/") || dir == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, strings.TrimPrefix(dir, "~"))
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(cwd, dir)
	}
	dir = filepath.Clean(dir)
	info, err := os.Stat(dir)
	if os.IsNotExist(err) {
		return "", fmt.Errorf("there is no folder %s", dir)
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder", dir)
	}
	if root := FindGitRoot(dir); root != "" {
		return root, nil
	}
	return dir, nil
}

func readJsonFile(path string, target any) (bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	return true, json.Unmarshal(data, target)
}

type saasFoundryManifest struct {
	ProjectName string `json:"projectName"`
	MainBranch  string `json:"mainBranch"`
	Workflow    *struct {
		ProjectUrl     string            `json:"projectUrl"`
		WorkingBranch  string            `json:"workingBranch"`
		PrTargetBranch string            `json:"prTargetBranch"`
		BranchNaming   map[string]string `json:"branchNaming"`
		CommitFormat   *struct {
			Pattern       string `json:"pattern"`
			RequireTicket bool   `json:"requireTicket"`
		} `json:"commitFormat"`
	} `json:"workflow"`
}

func readSaaSFoundry(dir string) (*ProjectConventions, string, bool) {
	var manifest saasFoundryManifest
	found, err := readJsonFile(filepath.Join(dir, ProjectSaaSFoundryFile), &manifest)
	if !found || err != nil {
		return nil, "", false
	}
	conv := &ProjectConventions{MainBranch: manifest.MainBranch}
	if wf := manifest.Workflow; wf != nil {
		conv.WorkingBranch = wf.WorkingBranch
		conv.PrTargetBranch = wf.PrTargetBranch
		conv.BranchNaming = wf.BranchNaming
		conv.ProjectUrl = wf.ProjectUrl
		if wf.CommitFormat != nil {
			conv.CommitPattern = wf.CommitFormat.Pattern
			conv.RequireTicket = wf.CommitFormat.RequireTicket
		}
	}
	return conv, manifest.ProjectName, true
}

// ReadProject reads what Moltenterm needs from a linked folder. A folder that disappeared is reported, not an error:
// the link stays until the user removes it.
func ReadProject(dir string) ProjectInfo {
	info := ProjectInfo{Dir: dir, Name: filepath.Base(dir)}
	stat, err := os.Stat(dir)
	if err != nil || !stat.IsDir() {
		return info
	}
	info.Exists = true
	info.GitRoot = FindGitRoot(dir)
	var pipeline struct {
		Name string `json:"name"`
	}
	found, err := readJsonFile(filepath.Join(dir, ProjectPipelineFile), &pipeline)
	info.HasPipeline = found && err == nil
	if found && err != nil {
		info.PipelineError = err.Error()
	}
	conv, sfName, hasSf := readSaaSFoundry(dir)
	if hasSf {
		info.Harness = "saasfoundryai"
		info.Conventions = conv
	}
	var pkg struct {
		Name string `json:"name"`
	}
	readJsonFile(filepath.Join(dir, "package.json"), &pkg)
	switch {
	case info.HasPipeline && pipeline.Name != "":
		info.Name = pipeline.Name
	case sfName != "":
		info.Name = sfName
	case pkg.Name != "":
		info.Name = pkg.Name
	}
	return info
}

// Where projects usually keep their icon, best first: square app icons before logos and favicons, which are often
// small or wide. must match LogoCandidatePaths in frontend/moltenterm-shell/workspace-project.ts
var projectLogoCandidates = []string{
	"icon.svg", "icon.png", "logo.svg", "logo.png",
	"build/icon.png", "build/icon.svg", "build/icons/icon.png", "build/icons/512x512.png", "build/icons/256x256.png", "build/appicon.png",
	"src-tauri/icons/icon.png", "src-tauri/icons/128x128@2x.png",
	"assets/icon.svg", "assets/icon.png", "assets/logo.svg", "assets/logo.png", "assets/appicon.png",
	"public/icon.svg", "public/icon.png", "public/logo.svg", "public/logo.png",
	"static/icon.svg", "static/icon.png", "static/logo.svg", "static/logo.png",
	"src/assets/icon.svg", "src/assets/icon.png", "src/assets/logo.svg", "src/assets/logo.png",
	"public/apple-touch-icon.png", "public/favicon.svg", "public/favicon.png", "public/favicon.ico",
	"static/favicon.svg", "static/favicon.png", "static/favicon.ico",
	"favicon.svg", "favicon.png", "favicon.ico",
}

var projectLogoExtensions = map[string]bool{".svg": true, ".png": true, ".ico": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true}

var readmeImageRegex = regexp.MustCompile(`(?i)<img[^>]*\ssrc=["']([^"']+)["']|!\[[^\]]*\]\(\s*<?([^)\s>]+)`)

// readmeFirstImage returns the README's first image when it is a file of the project (not a badge or a web URL).
func readmeFirstImage(dir string) string {
	for _, name := range []string{"README.md", "readme.md", "Readme.md"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		if len(data) > projectMaxReadmeBytes {
			data = data[:projectMaxReadmeBytes]
		}
		for _, match := range readmeImageRegex.FindAllStringSubmatch(string(data), -1) {
			src := match[1]
			if src == "" {
				src = match[2]
			}
			if strings.Contains(src, "://") || strings.HasPrefix(src, "data:") {
				continue
			}
			return strings.TrimPrefix(strings.SplitN(src, "#", 2)[0], "./")
		}
		return ""
	}
	return ""
}

func IsProjectLogoFile(path string) bool {
	return projectLogoExtensions[strings.ToLower(filepath.Ext(path))]
}

// declaredProjectIcon is the icon `.molten/project.json` names: the project knows better than any guess (#189).
func declaredProjectIcon(dir string) string {
	var pipeline struct {
		Icon string `json:"icon"`
	}
	readJsonFile(filepath.Join(dir, ProjectPipelineFile), &pipeline)
	return strings.TrimPrefix(filepath.ToSlash(pipeline.Icon), "./")
}

// FindProjectLogos lists the images that could stand for the project, as absolute paths, best first. Only files inside
// the project are offered.
func FindProjectLogos(dir string) []string {
	var logos []string
	seen := map[string]bool{}
	add := func(rel string) {
		if rel == "" || len(logos) >= projectMaxLogos || !IsProjectLogoFile(rel) {
			return
		}
		full := filepath.Clean(filepath.Join(dir, filepath.FromSlash(rel)))
		if seen[full] || !strings.HasPrefix(full, filepath.Clean(dir)+string(filepath.Separator)) {
			return
		}
		if stat, err := os.Stat(full); err != nil || !stat.Mode().IsRegular() {
			return
		}
		seen[full] = true
		logos = append(logos, full)
	}
	add(declaredProjectIcon(dir))
	for _, rel := range projectLogoCandidates {
		add(rel)
	}
	add(readmeFirstImage(dir))
	return logos
}
