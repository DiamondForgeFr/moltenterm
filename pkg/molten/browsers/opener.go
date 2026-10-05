// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browsers

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const (
	// `open` answers once LaunchServices has the request: far less than this.
	openTimeout = 15 * time.Second
	// A browser started from its desktop entry keeps running; one that cannot start exits within this delay.
	startFailureWindow = 2 * time.Second
)

// Runner runs an OS command and reports whether it failed to start the browser.
type Runner func(name string, args []string) error

// OpenRequest asks for a page in an engine: EngineApp, EngineInstalled, a browser id, or "" to route it.
type OpenRequest struct {
	Url    string `json:"url"`
	Engine string `json:"engine,omitempty"`
}

// ListResult is what the panels and `molten browsers` show.
type ListResult struct {
	Browsers []Browser         `json:"browsers"`
	Chosen   *Browser          `json:"chosen,omitempty"`
	Default  string            `json:"default"`
	Sites    map[string]string `json:"sites,omitempty"`
	// Why browser:installed names no usable browser.
	Problem string `json:"problem,omitempty"`
}

// SiteRequest sets the engine of a site (a host, which covers its subdomains); an empty engine removes the choice.
type SiteRequest struct {
	Site   string `json:"site"`
	Engine string `json:"engine,omitempty"`
}

type Opener struct {
	Goos     string
	Roots    Roots
	Settings func() Settings
	// Writes browser:sites to the user's settings.
	SaveSites func(sites map[string]string) error
	Run       Runner
}

func MakeOpener(settings func() Settings, saveSites func(sites map[string]string) error) *Opener {
	return &Opener{Goos: runtime.GOOS, Roots: DefaultRoots(), Settings: settings, SaveSites: saveSites, Run: ExecRunner}
}

// SetSite records the per-site choice and returns the new browser:sites.
func (o *Opener) SetSite(req SiteRequest) (map[string]string, error) {
	site := strings.ToLower(strings.TrimSpace(req.Site))
	if site == "" || strings.ContainsAny(site, "/: ") {
		return nil, fmt.Errorf("%q is not a site (a host such as example.com)", req.Site)
	}
	sites := make(map[string]string)
	for k, v := range o.settings().Sites {
		sites[k] = v
	}
	engine := strings.ToLower(strings.TrimSpace(req.Engine))
	if engine == "" {
		delete(sites, site)
	} else {
		sites[site] = engine
	}
	if o.SaveSites == nil {
		return nil, fmt.Errorf("the settings cannot be written")
	}
	if err := o.SaveSites(sites); err != nil {
		return nil, err
	}
	return sites, nil
}

func (o *Opener) settings() Settings {
	if o.Settings == nil {
		return Settings{}
	}
	return o.Settings()
}

func (o *Opener) List() ListResult {
	s := o.settings()
	found := Detect(o.Roots)
	if found == nil {
		found = []Browser{}
	}
	chosen, problem := Chosen(s.Installed, found)
	def := strings.ToLower(strings.TrimSpace(s.Default))
	if def == "" {
		def = EngineApp
	}
	return ListResult{Browsers: found, Chosen: chosen, Default: def, Sites: s.Sites, Problem: problem}
}

// Open routes the page and, when it goes to a browser, starts it there. A browser that is missing or fails to start
// gives a route to the app with the reason: the caller opens the page in the browser panel.
func (o *Opener) Open(req OpenRequest) Route {
	route := Resolve(req.Engine, req.Url, o.settings(), Detect(o.Roots))
	if route.Engine == EngineApp {
		return route
	}
	if err := o.launch(*route.Browser, req.Url); err != nil {
		log.Printf("molten: browser hand-off failed: %v\n", err)
		return Route{Engine: EngineApp, Site: route.Site, Fallback: err.Error()}
	}
	return route
}

// Activate brings the browser of a handed-off page to the front (macOS), or opens the page in it again (Linux).
func (o *Opener) Activate(req OpenRequest) Route {
	engine := req.Engine
	if engine == "" {
		engine = EngineInstalled
	}
	route := Resolve(engine, req.Url, o.settings(), Detect(o.Roots))
	if route.Engine == EngineApp {
		return route
	}
	page := req.Url
	if o.Goos == "darwin" {
		page = ""
	}
	if err := o.launch(*route.Browser, page); err != nil {
		log.Printf("molten: browser activation failed: %v\n", err)
		return Route{Engine: EngineApp, Fallback: err.Error()}
	}
	return route
}

func (o *Opener) launch(b Browser, page string) error {
	if !isFile(b.Path) {
		return fmt.Errorf("%s cannot be found at %s", b.Name, b.Path)
	}
	name, args, err := Command(o.Goos, b, page)
	if err != nil {
		return fmt.Errorf("%s could not start: %w", b.Name, err)
	}
	log.Printf("molten: browser hand-off: %s %s\n", name, strings.Join(args, " "))
	if err := o.Run(name, args); err != nil {
		return fmt.Errorf("%s could not start: %w", b.Name, err)
	}
	return nil
}

// ExecRunner runs the command: `open` is waited for (it fails when the app cannot be launched); a browser started
// from its desktop entry is left running, and only an exit within startFailureWindow counts as a failure.
func ExecRunner(name string, args []string) error {
	if name == "open" {
		ctx, cancel := context.WithTimeout(context.Background(), openTimeout)
		defer cancel()
		out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
		if err != nil {
			if msg := strings.TrimSpace(string(out)); msg != "" {
				return fmt.Errorf("%s", msg)
			}
			return err
		}
		return nil
	}
	cmd := exec.Command(name, args...)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return err
		}
		return nil
	case <-time.After(startFailureWindow):
		return nil
	}
}
