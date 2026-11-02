// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A project's launch recipe (FR-REV-031, DS-REV-019): how the Reviews view's Launch serves a version on this computer.
// It is proposed from the project (`launch` in .molten/project.json, else its package.json scripts), and runs only once
// the developer confirmed it in the recipe dialog: that confirmed copy lives in MoltenTerm's data folder, keyed by
// project folder, never in the repository.

const (
	LaunchRecipeCommand     = "moltenmissionlaunchrecipe"
	LaunchSaveRecipeCommand = "moltenmissionlaunchsaverecipe"

	LaunchRecipeFromProject  = "project"
	LaunchRecipeFromDetected = "detected"

	launchRecipesFile = "recipes.json"
)

// Ordered by preference: a script made for the dev database first.
var launchMigrationScripts = []string{"db:update:dev", "db:migrate:dev", "migrate:dev", "db:migrate", "migrate"}

var launchPortInScript = regexp.MustCompile(`(?:--port[= ]|\s-p\s+|PORT=)(\d{2,5})\b`)
var launchPortInEnv = regexp.MustCompile(`(?m)^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})["']?\s*$`)
var launchIdUnsafe = regexp.MustCompile(`[^a-z0-9._-]+`)

// The web tools a dev script names, with the port they serve on by default.
var launchWebTools = []struct {
	word string
	port int
}{{"vite", 5173}, {"next", 3000}, {"nuxt", 3000}, {"astro", 4321}, {"webpack", 8080}}

type LaunchRecipeStep struct {
	Id    string `json:"id"`
	Title string `json:"title,omitempty"`
	Run   string `json:"run"`
	Cwd   string `json:"cwd,omitempty"`
}

type LaunchRecipeServer struct {
	Id    string `json:"id"`
	Title string `json:"title,omitempty"`
	Run   string `json:"run"`
	Cwd   string `json:"cwd,omitempty"`
	Port  int    `json:"port,omitempty"`
}

// must match LaunchRecipe in frontend/moltenterm-shell/reviews/reviews-launch-model.ts
type LaunchRecipe struct {
	Where   string               `json:"where,omitempty"`
	Prepare []LaunchRecipeStep   `json:"prepare"`
	Servers []LaunchRecipeServer `json:"servers"`
	Url     string               `json:"url,omitempty"`
}

type LaunchRecipeRequest struct {
	Dir string `json:"dir"`
}

type LaunchSaveRecipeRequest struct {
	Dir    string       `json:"dir"`
	Recipe LaunchRecipe `json:"recipe"`
}

// must match LaunchRecipeAnswer in frontend/moltenterm-shell/reviews/reviews-launch-model.ts
type LaunchRecipeAnswer struct {
	Dir string `json:"dir"`
	// The confirmed recipe, the one Launch runs; nil until the developer confirmed one.
	Saved *LaunchRecipe `json:"saved,omitempty"`
	// What the project proposes, and from where (LaunchRecipeFrom…); nil when nothing could be told.
	Proposal     *LaunchRecipe `json:"proposal,omitempty"`
	ProposalFrom string        `json:"proposalfrom,omitempty"`
}

type launchRecipes struct {
	lock sync.Mutex
	file string
}

func (s *launchRecipes) readAll() map[string]LaunchRecipe {
	rtn := map[string]LaunchRecipe{}
	data, err := os.ReadFile(s.file)
	if err != nil {
		return rtn
	}
	json.Unmarshal(data, &rtn)
	return rtn
}

func (s *launchRecipes) get(dir string) *LaunchRecipe {
	s.lock.Lock()
	defer s.lock.Unlock()
	recipe, ok := s.readAll()[filepath.Clean(dir)]
	if !ok {
		return nil
	}
	return &recipe
}

func (s *launchRecipes) save(dir string, recipe LaunchRecipe) error {
	s.lock.Lock()
	defer s.lock.Unlock()
	all := s.readAll()
	all[filepath.Clean(dir)] = recipe
	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.file), 0700); err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// normalizeLaunchRecipe trims the recipe and refuses one that cannot run; the dialog checks the same before saving.
func normalizeLaunchRecipe(dir string, recipe LaunchRecipe) (LaunchRecipe, error) {
	rtn := LaunchRecipe{Where: strings.TrimSpace(recipe.Where), Url: strings.TrimSpace(recipe.Url), Prepare: []LaunchRecipeStep{}, Servers: []LaunchRecipeServer{}}
	if rtn.Where == "" {
		rtn.Where = molten.PipelineLaunchWhereMain
	}
	if rtn.Where != molten.PipelineLaunchWhereMain && rtn.Where != molten.PipelineLaunchWhereWorktree {
		return rtn, fmt.Errorf("where must be %q or %q", molten.PipelineLaunchWhereMain, molten.PipelineLaunchWhereWorktree)
	}
	if rtn.Url != "" && !strings.HasPrefix(rtn.Url, "http://") && !strings.HasPrefix(rtn.Url, "https://") {
		return rtn, fmt.Errorf("the ready URL must start with http:// or https://")
	}
	seen := map[string]bool{}
	checkCwd := func(cwd string) (string, error) {
		cwd = strings.TrimSpace(cwd)
		if cwd == "" || filepath.Clean(cwd) == "." {
			return "", nil
		}
		if filepath.IsAbs(cwd) || !insideFolder(dir, filepath.Join(dir, cwd)) {
			return "", fmt.Errorf("the folder %q leaves the project", cwd)
		}
		return filepath.ToSlash(filepath.Clean(cwd)), nil
	}
	checkId := func(id string, fallback string) string {
		id = launchIdUnsafe.ReplaceAllString(strings.ToLower(strings.TrimSpace(id)), "-")
		id = strings.Trim(id, "-")
		if id == "" {
			id = fallback
		}
		base := id
		for i := 2; seen[id]; i++ {
			id = fmt.Sprintf("%s-%d", base, i)
		}
		seen[id] = true
		return id
	}
	for i, step := range recipe.Prepare {
		run := strings.TrimSpace(step.Run)
		if run == "" {
			continue
		}
		cwd, err := checkCwd(step.Cwd)
		if err != nil {
			return rtn, err
		}
		rtn.Prepare = append(rtn.Prepare, LaunchRecipeStep{Id: checkId(step.Id, fmt.Sprintf("step-%d", i+1)), Title: strings.TrimSpace(step.Title), Run: run, Cwd: cwd})
	}
	ports := map[int]bool{}
	for i, server := range recipe.Servers {
		run := strings.TrimSpace(server.Run)
		if run == "" {
			continue
		}
		cwd, err := checkCwd(server.Cwd)
		if err != nil {
			return rtn, err
		}
		if server.Port < 0 || server.Port > 65535 {
			return rtn, fmt.Errorf("port %d is not a port", server.Port)
		}
		if server.Port > 0 && ports[server.Port] {
			return rtn, fmt.Errorf("port %d is declared twice", server.Port)
		}
		ports[server.Port] = true
		rtn.Servers = append(rtn.Servers, LaunchRecipeServer{Id: checkId(server.Id, fmt.Sprintf("server-%d", i+1)), Title: strings.TrimSpace(server.Title), Run: run, Cwd: cwd, Port: server.Port})
	}
	if len(rtn.Servers) == 0 {
		return rtn, fmt.Errorf("a recipe starts at least one server")
	}
	return rtn, nil
}

func insideFolder(root string, path string) bool {
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

// projectLaunchRecipe is the `launch` a valid .molten/project.json declares.
func projectLaunchRecipe(dir string) *LaunchRecipe {
	report := molten.ValidatePipeline(dir)
	if !report.Valid || report.Pipeline == nil || report.Pipeline.Launch == nil {
		return nil
	}
	launch := report.Pipeline.Launch
	rtn := LaunchRecipe{Where: launch.Where, Url: launch.Url, Prepare: []LaunchRecipeStep{}, Servers: []LaunchRecipeServer{}}
	for _, step := range launch.Prepare {
		rtn.Prepare = append(rtn.Prepare, LaunchRecipeStep{Id: step.Id, Title: step.Title, Run: launchCommandWithEnv(step.PipelineCommand), Cwd: step.Cwd})
	}
	for _, server := range launch.Servers {
		rtn.Servers = append(rtn.Servers, LaunchRecipeServer{Id: server.Id, Title: server.Title, Run: launchCommandWithEnv(server.PipelineCommand), Cwd: server.Cwd, Port: server.Port})
	}
	if rtn.Where == "" {
		rtn.Where = molten.PipelineLaunchWhereMain
	}
	return &rtn
}

// The recipe keeps one command line per step: a declared env becomes its prefix, visible and editable in the dialog.
func launchCommandWithEnv(cmd molten.PipelineCommand) string {
	if len(cmd.Env) == 0 {
		return cmd.Run
	}
	keys := make([]string, 0, len(cmd.Env))
	for k := range cmd.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		parts = append(parts, k+"="+launchEnvQuote(cmd.Env[k]))
	}
	return strings.Join(parts, " ") + " " + cmd.Run
}

func launchEnvQuote(value string) string {
	if value != "" && !strings.ContainsAny(value, " \t\n'\"\\$`;&|<>(){}*?[]#~") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

type launchPackage struct {
	rel     string
	name    string
	scripts map[string]string
}

func readLaunchPackage(dir string, rel string) *launchPackage {
	data, err := os.ReadFile(filepath.Join(dir, rel, "package.json"))
	if err != nil {
		return nil
	}
	var pkg struct {
		Name    string            `json:"name"`
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(data, &pkg) != nil {
		return nil
	}
	return &launchPackage{rel: filepath.ToSlash(rel), name: pkg.Name, scripts: pkg.Scripts}
}

// The workspaces of the root package.json: an array, or {packages: [...]}, each a folder or a one-level glob.
func launchWorkspaces(dir string) []string {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return nil
	}
	var root struct {
		Workspaces json.RawMessage `json:"workspaces"`
	}
	if json.Unmarshal(data, &root) != nil || len(root.Workspaces) == 0 {
		return nil
	}
	var patterns []string
	if json.Unmarshal(root.Workspaces, &patterns) != nil {
		var obj struct {
			Packages []string `json:"packages"`
		}
		json.Unmarshal(root.Workspaces, &obj)
		patterns = obj.Packages
	}
	seen := map[string]bool{}
	rtn := []string{}
	for _, pattern := range patterns {
		pattern = strings.TrimSuffix(strings.TrimPrefix(pattern, "./"), "/")
		if pattern == "" || strings.HasPrefix(pattern, "!") || strings.Contains(pattern, "..") {
			continue
		}
		matches, _ := filepath.Glob(filepath.Join(dir, filepath.FromSlash(pattern)))
		for _, match := range matches {
			rel, err := filepath.Rel(dir, match)
			if err != nil || seen[rel] {
				continue
			}
			if _, err := os.Stat(filepath.Join(match, "package.json")); err != nil {
				continue
			}
			seen[rel] = true
			rtn = append(rtn, rel)
		}
	}
	sort.Strings(rtn)
	return rtn
}

func launchPackageManager(dir string) string {
	for _, lock := range []struct{ file, manager string }{
		{"bun.lockb", "bun"}, {"bun.lock", "bun"}, {"pnpm-lock.yaml", "pnpm"}, {"yarn.lock", "yarn"},
	} {
		if _, err := os.Stat(filepath.Join(dir, lock.file)); err == nil {
			return lock.manager
		}
	}
	return "npm"
}

// launchScriptCommand runs a script of pkg: npm names the workspace from the root (`npm run x -w apps/api`), the
// other managers run in the package's folder.
func launchScriptCommand(manager string, pkg *launchPackage, script string) (string, string) {
	if manager == "npm" {
		if pkg.rel == "" || pkg.rel == "." {
			return "npm run " + script, ""
		}
		return "npm run " + script + " -w " + pkg.rel, ""
	}
	cwd := pkg.rel
	if cwd == "." {
		cwd = ""
	}
	return manager + " run " + script, cwd
}

func launchServerPort(dir string, pkg *launchPackage, script string) (int, bool) {
	web := false
	defaultPort := 0
	lower := strings.ToLower(script)
	for _, tool := range launchWebTools {
		if regexp.MustCompile(`\b` + tool.word + `\b`).MatchString(lower) {
			web = true
			defaultPort = tool.port
			break
		}
	}
	if m := launchPortInScript.FindStringSubmatch(" " + script); m != nil {
		if port, err := strconv.Atoi(m[1]); err == nil && port > 0 && port <= 65535 {
			return port, web
		}
	}
	for _, name := range []string{".env.development.local", ".env.local", ".env.development", ".env"} {
		data, err := os.ReadFile(filepath.Join(dir, pkg.rel, name))
		if err != nil {
			continue
		}
		if m := launchPortInEnv.FindSubmatch(data); m != nil {
			if port, err := strconv.Atoi(string(m[1])); err == nil && port > 0 && port <= 65535 {
				return port, web
			}
		}
	}
	return defaultPort, web
}

func launchPackageId(pkg *launchPackage) string {
	if pkg.rel == "" || pkg.rel == "." {
		return "app"
	}
	id := launchIdUnsafe.ReplaceAllString(strings.ToLower(filepath.Base(pkg.rel)), "-")
	if id = strings.Trim(id, "-"); id == "" {
		return "app"
	}
	return id
}

// detectLaunchRecipe proposes a recipe from the package.json scripts: an install, each workspace's migration of its
// dev database, and each workspace's dev server with its port. Nil when no dev server is found: the dialog asks.
func detectLaunchRecipe(dir string) *LaunchRecipe {
	root := readLaunchPackage(dir, "")
	if root == nil {
		return nil
	}
	manager := launchPackageManager(dir)
	packages := []*launchPackage{}
	for _, rel := range launchWorkspaces(dir) {
		if pkg := readLaunchPackage(dir, rel); pkg != nil {
			packages = append(packages, pkg)
		}
	}
	if len(packages) == 0 {
		packages = append(packages, root)
	}
	rtn := LaunchRecipe{Where: molten.PipelineLaunchWhereMain, Prepare: []LaunchRecipeStep{{Id: "install", Run: manager + " install"}}, Servers: []LaunchRecipeServer{}}
	seen := map[string]bool{"install": true}
	uniqueId := func(id string) string {
		base := id
		for i := 2; seen[id]; i++ {
			id = fmt.Sprintf("%s-%d", base, i)
		}
		seen[id] = true
		return id
	}
	webPort := 0
	for _, pkg := range packages {
		for _, script := range launchMigrationScripts {
			if _, ok := pkg.scripts[script]; !ok {
				continue
			}
			run, cwd := launchScriptCommand(manager, pkg, script)
			rtn.Prepare = append(rtn.Prepare, LaunchRecipeStep{Id: uniqueId("migrate-" + launchPackageId(pkg)), Run: run, Cwd: cwd})
			break
		}
	}
	for _, pkg := range packages {
		script, ok := pkg.scripts["dev"]
		if !ok {
			continue
		}
		run, cwd := launchScriptCommand(manager, pkg, "dev")
		port, web := launchServerPort(dir, pkg, script)
		if port > 0 {
			for _, other := range rtn.Servers {
				if other.Port == port {
					port = 0
				}
			}
		}
		rtn.Servers = append(rtn.Servers, LaunchRecipeServer{Id: uniqueId(launchPackageId(pkg)), Run: run, Cwd: cwd, Port: port})
		if web && port > 0 && webPort == 0 {
			webPort = port
		}
	}
	if len(rtn.Servers) == 0 {
		return nil
	}
	if webPort == 0 {
		for _, server := range rtn.Servers {
			if server.Port > 0 {
				webPort = server.Port
				break
			}
		}
	}
	if webPort > 0 {
		rtn.Url = fmt.Sprintf("http://localhost:%d", webPort)
	}
	return &rtn
}

// RecipeOf answers the recipe dialog and Launch: the saved recipe and the project's proposal.
func (l *Launches) RecipeOf(req LaunchRecipeRequest) (LaunchRecipeAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return LaunchRecipeAnswer{}, err
	}
	rtn := LaunchRecipeAnswer{Dir: req.Dir, Saved: l.recipes.get(req.Dir)}
	if proposal := projectLaunchRecipe(req.Dir); proposal != nil {
		rtn.Proposal, rtn.ProposalFrom = proposal, LaunchRecipeFromProject
	} else if proposal := detectLaunchRecipe(req.Dir); proposal != nil {
		rtn.Proposal, rtn.ProposalFrom = proposal, LaunchRecipeFromDetected
	}
	return rtn, nil
}

// SaveRecipe keeps the developer's confirmed recipe: confirming it is trusting its commands.
func (l *Launches) SaveRecipe(req LaunchSaveRecipeRequest) (LaunchRecipeAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return LaunchRecipeAnswer{}, err
	}
	recipe, err := normalizeLaunchRecipe(req.Dir, req.Recipe)
	if err != nil {
		return LaunchRecipeAnswer{}, err
	}
	if err := l.recipes.save(req.Dir, recipe); err != nil {
		return LaunchRecipeAnswer{}, err
	}
	return l.RecipeOf(LaunchRecipeRequest{Dir: req.Dir})
}
