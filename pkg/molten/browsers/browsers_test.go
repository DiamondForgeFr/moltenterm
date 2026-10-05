// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browsers

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func makeApp(t *testing.T, dir string, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Join(path, "Contents"), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func makeDesktop(t *testing.T, dir string, name string, body string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDetectMacAppsInKnownOrder(t *testing.T) {
	sys := t.TempDir()
	user := t.TempDir()
	chrome := makeApp(t, sys, "Google Chrome.app")
	brave := makeApp(t, user, "Brave Browser.app")
	makeApp(t, sys, "Safari.app")
	got := Detect(Roots{Goos: "darwin", AppDirs: []string{sys, user}})
	want := []Browser{{Id: "brave", Name: "Brave", Path: brave}, {Id: "chrome", Name: "Chrome", Path: chrome}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Detect = %#v, want %#v", got, want)
	}
}

func TestDetectLinuxDesktopEntries(t *testing.T) {
	local := filepath.Join(t.TempDir(), "applications")
	flatpak := filepath.Join(t.TempDir(), "applications")
	vivaldi := makeDesktop(t, local, "vivaldi-stable.desktop", "[Desktop Entry]\nExec=vivaldi %U\n")
	brave := makeDesktop(t, flatpak, "com.brave.Browser.desktop", "[Desktop Entry]\nExec=flatpak run com.brave.Browser @@u %U @@\n")
	got := Detect(Roots{Goos: "linux", DesktopDirs: []string{local, filepath.Join(t.TempDir(), "missing"), flatpak}})
	want := []Browser{{Id: "brave", Name: "Brave", Path: brave}, {Id: "vivaldi", Name: "Vivaldi", Path: vivaldi}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Detect = %#v, want %#v", got, want)
	}
}

func TestChosen(t *testing.T) {
	found := []Browser{{Id: "brave", Name: "Brave", Path: "/A/Brave Browser.app"}, {Id: "chrome", Name: "Chrome", Path: "/A/Google Chrome.app"}}
	if b, _ := Chosen("", found); b == nil || b.Id != "brave" {
		t.Fatalf("empty setting should choose the first found, got %#v", b)
	}
	if b, _ := Chosen("Chrome", found); b == nil || b.Id != "chrome" {
		t.Fatalf("id is case-insensitive, got %#v", b)
	}
	if b, reason := Chosen("edge", found); b != nil || reason != "Edge is not installed" {
		t.Fatalf("missing browser: %#v %q", b, reason)
	}
	if b, reason := Chosen("", nil); b != nil || !strings.Contains(reason, "no Chromium browser") {
		t.Fatalf("no browser: %#v %q", b, reason)
	}
	thorium := makeApp(t, t.TempDir(), "Thorium.app")
	b, _ := Chosen(thorium, found)
	if b == nil || *b != (Browser{Id: CustomBrowserId, Name: "Thorium", Path: thorium}) {
		t.Fatalf("path setting: %#v", b)
	}
	if b, reason := Chosen("/nowhere/Thorium.app", found); b != nil || reason != "Thorium cannot be found at /nowhere/Thorium.app" {
		t.Fatalf("missing path: %#v %q", b, reason)
	}
}

func TestSiteEngine(t *testing.T) {
	sites := map[string]string{"Example.com": "brave", "docs.example.com": "app", "claude.ai": " Installed "}
	cases := []struct{ url, engine, site string }{
		{"https://example.com/x", "brave", "example.com"},
		{"https://app.example.com/x", "brave", "example.com"},
		{"https://docs.example.com/", "app", "docs.example.com"},
		{"https://a.docs.example.com/", "app", "docs.example.com"},
		{"https://claude.ai/artifact/1", "installed", "claude.ai"},
		{"https://notexample.com/", "", ""},
		{"not a url", "", ""},
	}
	for _, c := range cases {
		engine, site := SiteEngine(sites, c.url)
		if engine != c.engine || site != c.site {
			t.Errorf("SiteEngine(%q) = %q %q, want %q %q", c.url, engine, site, c.engine, c.site)
		}
	}
}

func TestResolve(t *testing.T) {
	found := []Browser{{Id: "brave", Name: "Brave", Path: "/A/Brave Browser.app"}, {Id: "chrome", Name: "Chrome", Path: "/A/Google Chrome.app"}}
	settings := Settings{Installed: "chrome", Sites: map[string]string{"github.com": "installed", "localhost": "app"}}
	page := "https://github.com/DiamondForgeFr"
	cases := []struct {
		name      string
		requested string
		url       string
		settings  Settings
		engine    string
		fallback  string
	}{
		{"explicit app wins over the site", "app", page, settings, EngineApp, ""},
		{"explicit browser id", "brave", page, settings, "brave", ""},
		{"site choice uses the chosen browser", "", page, settings, "chrome", ""},
		{"no site choice: default app", "", "https://example.com", settings, EngineApp, ""},
		{"default engine", "", "https://example.com", Settings{Default: "installed"}, "brave", ""},
		{"site set to app beats default", "", "http://localhost:3000", Settings{Default: "brave", Sites: settings.Sites}, EngineApp, ""},
		{"missing browser falls back", "edge", page, settings, EngineApp, "Edge is not installed"},
		{"non-web page stays in app", "brave", "file:///tmp/x.html", settings, EngineApp, "only web pages (http, https) open in Brave"},
	}
	for _, c := range cases {
		route := Resolve(c.requested, c.url, c.settings, found)
		if route.Engine != c.engine || route.Fallback != c.fallback {
			t.Errorf("%s: Resolve = %#v, want engine %q fallback %q", c.name, route, c.engine, c.fallback)
		}
	}
	if route := Resolve("", page, settings, found); route.Site != "github.com" {
		t.Errorf("site not reported: %#v", route)
	}
}

func TestExpandDesktopExec(t *testing.T) {
	url := "https://example.com/a?b=1&c=%20"
	cases := []struct {
		exec string
		want []string
	}{
		{"/usr/bin/brave-browser-stable %U", []string{"/usr/bin/brave-browser-stable", url}},
		{"flatpak run --command=brave com.brave.Browser @@u %U @@", []string{"flatpak", "run", "--command=brave", "com.brave.Browser", "@@u", url, "@@"}},
		{`"/opt/My Browser/chrome" --profile-directory=Default %u %i`, []string{"/opt/My Browser/chrome", "--profile-directory=Default", url}},
		{"chromium", []string{"chromium", url}},
		{"chromium --name=100%%", []string{"chromium", "--name=100%", url}},
	}
	for _, c := range cases {
		got, err := ExpandDesktopExec(c.exec, url)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("ExpandDesktopExec(%q) = %#v %v, want %#v", c.exec, got, err, c.want)
		}
	}
	if _, err := ExpandDesktopExec(`"unterminated %U`, url); err == nil {
		t.Errorf("unterminated quote should fail")
	}
}

func TestCommand(t *testing.T) {
	mac := Browser{Id: "brave", Name: "Brave", Path: "/Applications/Brave Browser.app"}
	name, args, _ := Command("darwin", mac, "https://example.com")
	if name != "open" || !reflect.DeepEqual(args, []string{"-a", mac.Path, "https://example.com"}) {
		t.Errorf("open: %s %#v", name, args)
	}
	name, args, _ = Command("darwin", mac, "")
	if name != "open" || !reflect.DeepEqual(args, []string{"-a", mac.Path}) {
		t.Errorf("activate: %s %#v", name, args)
	}
	desktop := makeDesktop(t, t.TempDir(), "brave-browser.desktop",
		"[Desktop Entry]\nName=Brave\nExec=brave-browser-stable %U\n[Desktop Action new-window]\nExec=brave-browser-stable --new-window\n")
	name, args, err := Command("linux", Browser{Id: "brave", Name: "Brave", Path: desktop}, "https://example.com")
	if err != nil || name != "brave-browser-stable" || !reflect.DeepEqual(args, []string{"https://example.com"}) {
		t.Errorf("linux: %s %#v %v", name, args, err)
	}
	if _, _, err := Command("linux", Browser{Name: "Brave", Path: desktop}, ""); err == nil {
		t.Errorf("linux activation without a page should fail")
	}
}

type runCall struct {
	name string
	args []string
}

func makeTestOpener(t *testing.T, settings Settings, runErr error) (*Opener, *[]runCall, string) {
	dir := t.TempDir()
	brave := makeApp(t, dir, "Brave Browser.app")
	var calls []runCall
	o := &Opener{
		Goos:     "darwin",
		Roots:    Roots{Goos: "darwin", AppDirs: []string{dir}},
		Settings: func() Settings { return settings },
		Run: func(name string, args []string) error {
			calls = append(calls, runCall{name, args})
			return runErr
		},
	}
	return o, &calls, brave
}

func TestOpenerHandsOff(t *testing.T) {
	o, calls, brave := makeTestOpener(t, Settings{Sites: map[string]string{"claude.ai": "brave"}}, nil)
	route := o.Open(OpenRequest{Url: "https://claude.ai/new"})
	if route.Engine != "brave" || route.Fallback != "" || route.Site != "claude.ai" {
		t.Fatalf("route = %#v", route)
	}
	want := []runCall{{"open", []string{"-a", brave, "https://claude.ai/new"}}}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("calls = %#v", *calls)
	}
	*calls = nil
	if route := o.Open(OpenRequest{Url: "https://example.com"}); route.Engine != EngineApp || len(*calls) != 0 {
		t.Fatalf("unrouted page should stay in the app: %#v %#v", route, *calls)
	}
	if route := o.Activate(OpenRequest{Engine: "brave", Url: "https://claude.ai/new"}); route.Engine != "brave" {
		t.Fatalf("activate: %#v", route)
	}
	if !reflect.DeepEqual(*calls, []runCall{{"open", []string{"-a", brave}}}) {
		t.Fatalf("activate should only bring the browser forward: %#v", *calls)
	}
}

func TestOpenerFallsBack(t *testing.T) {
	o, _, _ := makeTestOpener(t, Settings{}, errors.New("Unable to find application"))
	route := o.Open(OpenRequest{Url: "https://example.com", Engine: "installed"})
	if route.Engine != EngineApp || route.Fallback != "Brave could not start: Unable to find application" {
		t.Fatalf("failed start: %#v", route)
	}
	missing := filepath.Join(t.TempDir(), "Gone.app")
	o, calls, _ := makeTestOpener(t, Settings{Installed: missing}, nil)
	route = o.Open(OpenRequest{Url: "https://example.com", Engine: "installed"})
	if route.Engine != EngineApp || !strings.Contains(route.Fallback, "Gone cannot be found at") || len(*calls) != 0 {
		t.Fatalf("missing path: %#v %#v", route, *calls)
	}
}

func TestOpenerSetSite(t *testing.T) {
	o, _, _ := makeTestOpener(t, Settings{Sites: map[string]string{"github.com": "app"}}, nil)
	var saved map[string]string
	o.SaveSites = func(sites map[string]string) error {
		saved = sites
		return nil
	}
	if _, err := o.SetSite(SiteRequest{Site: " Claude.AI ", Engine: "Brave"}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(saved, map[string]string{"github.com": "app", "claude.ai": "brave"}) {
		t.Fatalf("saved = %#v", saved)
	}
	if _, err := o.SetSite(SiteRequest{Site: "github.com"}); err != nil || !reflect.DeepEqual(saved, map[string]string{}) {
		t.Fatalf("removal: %#v %v", saved, err)
	}
	if _, err := o.SetSite(SiteRequest{Site: "https://x.com/"}); err == nil {
		t.Fatalf("a URL is not a site")
	}
}

func TestOpenerList(t *testing.T) {
	o, _, brave := makeTestOpener(t, Settings{Installed: "chrome"}, nil)
	list := o.List()
	if len(list.Browsers) != 1 || list.Browsers[0].Path != brave || list.Chosen != nil || list.Problem != "Chrome is not installed" || list.Default != EngineApp {
		t.Fatalf("list = %#v", list)
	}
}
