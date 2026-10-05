// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package browsers hands web pages off to the user's installed Chromium browser (FR-BRW-002, DS-BRW-002): it finds
// the browsers (macOS app bundles, Linux desktop entries), routes a page to an engine (explicit choice, then the
// per-site choice, then the default engine) and asks the OS to open it. MoltenTerm's own browser panel is the "app"
// engine; a page meant for a browser that is missing or fails to start falls back to it, with the reason.
package browsers

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// The in-app engine: MoltenTerm's browser panel.
	EngineApp = "app"
	// The installed browser chosen in the settings (browser:installed), whatever it is.
	EngineInstalled = "installed"
	// The id of a browser named by its path in browser:installed instead of a known id.
	CustomBrowserId = "custom"
)

// Browser is an installed Chromium browser. Path is its app bundle (macOS) or desktop entry (Linux).
type Browser struct {
	Id   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

// Settings are the browser:* settings (pkg/wconfig/settingsconfig.go).
type Settings struct {
	Installed string
	Default   string
	Sites     map[string]string
}

type knownBrowser struct {
	id         string
	name       string
	macApps    []string
	desktopIds []string
}

// The Chromium browsers MoltenTerm recognises, in the order the first found is chosen when browser:installed is empty.
var knownBrowsers = []knownBrowser{
	{"brave", "Brave", []string{"Brave Browser.app"}, []string{"brave-browser.desktop", "brave.desktop", "com.brave.Browser.desktop"}},
	{"chrome", "Chrome", []string{"Google Chrome.app"}, []string{"google-chrome.desktop", "com.google.Chrome.desktop"}},
	{"edge", "Edge", []string{"Microsoft Edge.app"}, []string{"microsoft-edge.desktop", "com.microsoft.Edge.desktop"}},
	{"arc", "Arc", []string{"Arc.app"}, nil},
	{"vivaldi", "Vivaldi", []string{"Vivaldi.app"}, []string{"vivaldi-stable.desktop", "vivaldi.desktop", "com.vivaldi.Vivaldi.desktop"}},
	{"opera", "Opera", []string{"Opera.app"}, []string{"opera.desktop", "com.opera.Opera.desktop"}},
	{"chromium", "Chromium", []string{"Chromium.app"}, []string{"chromium.desktop", "chromium-browser.desktop", "org.chromium.Chromium.desktop"}},
}

// Roots are the folders searched: app folders on macOS, desktop entry folders on Linux.
type Roots struct {
	Goos        string
	AppDirs     []string
	DesktopDirs []string
}

// DefaultRoots are the standard locations of this machine.
func DefaultRoots() Roots {
	home, _ := os.UserHomeDir()
	roots := Roots{Goos: runtime.GOOS}
	if runtime.GOOS == "darwin" {
		roots.AppDirs = []string{"/Applications", filepath.Join(home, "Applications")}
		return roots
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	dataDirs := os.Getenv("XDG_DATA_DIRS")
	if dataDirs == "" {
		dataDirs = "/usr/local/share:/usr/share"
	}
	dirs := []string{dataHome}
	dirs = append(dirs, filepath.SplitList(dataDirs)...)
	dirs = append(dirs, filepath.Join(home, ".local", "share", "flatpak", "exports", "share"),
		"/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop")
	for _, dir := range dirs {
		roots.DesktopDirs = append(roots.DesktopDirs, filepath.Join(dir, "applications"))
	}
	return roots
}

func isFile(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Detect lists the known browsers found under roots, in the order of knownBrowsers.
func Detect(roots Roots) []Browser {
	var rtn []Browser
	for _, kb := range knownBrowsers {
		if path := findBrowser(kb, roots); path != "" {
			rtn = append(rtn, Browser{Id: kb.id, Name: kb.name, Path: path})
		}
	}
	return rtn
}

func findBrowser(kb knownBrowser, roots Roots) string {
	if roots.Goos == "darwin" {
		for _, dir := range roots.AppDirs {
			for _, app := range kb.macApps {
				if path := filepath.Join(dir, app); isFile(path) {
					return path
				}
			}
		}
		return ""
	}
	for _, dir := range roots.DesktopDirs {
		for _, id := range kb.desktopIds {
			if path := filepath.Join(dir, id); isFile(path) {
				return path
			}
		}
	}
	return ""
}

// BrowserFromPath is the browser browser:installed names by its path (an app bundle or a desktop entry).
func BrowserFromPath(path string) Browser {
	name := strings.TrimSuffix(strings.TrimSuffix(filepath.Base(path), ".app"), ".desktop")
	return Browser{Id: CustomBrowserId, Name: name, Path: path}
}

func findById(found []Browser, id string) *Browser {
	for i := range found {
		if found[i].Id == id {
			return &found[i]
		}
	}
	return nil
}

func knownName(id string) string {
	for _, kb := range knownBrowsers {
		if kb.id == id {
			return kb.name
		}
	}
	return id
}

// Chosen is the browser of browser:installed: a known id, a path, or the first browser found when it is empty.
// The reason says why there is none.
func Chosen(installed string, found []Browser) (*Browser, string) {
	installed = strings.TrimSpace(installed)
	if installed == "" {
		if len(found) == 0 {
			return nil, "no Chromium browser was found on this computer"
		}
		return &found[0], ""
	}
	if filepath.IsAbs(installed) {
		b := BrowserFromPath(installed)
		if !isFile(installed) {
			return nil, fmt.Sprintf("%s cannot be found at %s", b.Name, installed)
		}
		return &b, ""
	}
	if b := findById(found, strings.ToLower(installed)); b != nil {
		return b, ""
	}
	return nil, fmt.Sprintf("%s is not installed", knownName(strings.ToLower(installed)))
}

// SiteEngine is the per-site choice for rawUrl: the entry of its host, else of its closest parent domain
// (example.com covers app.example.com). site is the matching entry.
func SiteEngine(sites map[string]string, rawUrl string) (engine string, site string) {
	u, err := url.Parse(rawUrl)
	if err != nil || u.Hostname() == "" || len(sites) == 0 {
		return "", ""
	}
	lower := make(map[string]string, len(sites))
	for k, v := range sites {
		lower[strings.ToLower(strings.TrimSpace(k))] = v
	}
	host := strings.ToLower(u.Hostname())
	for {
		if v, ok := lower[host]; ok && strings.TrimSpace(v) != "" {
			return strings.ToLower(strings.TrimSpace(v)), host
		}
		dot := strings.IndexByte(host, '.')
		if dot < 0 {
			return "", ""
		}
		host = host[dot+1:]
	}
}

// Route is where a page opens. Engine is EngineApp or the id of Browser; Fallback says why a page meant for a browser
// opens in the app instead; Site is the per-site entry that chose the engine.
type Route struct {
	Engine   string   `json:"engine"`
	Browser  *Browser `json:"browser,omitempty"`
	Site     string   `json:"site,omitempty"`
	Fallback string   `json:"fallback,omitempty"`
}

func isWebUrl(rawUrl string) bool {
	u, err := url.Parse(rawUrl)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// Resolve routes rawUrl: the requested engine, else the per-site choice, else browser:default, else the app.
func Resolve(requested string, rawUrl string, s Settings, found []Browser) Route {
	engine := strings.ToLower(strings.TrimSpace(requested))
	site := ""
	if engine == "" {
		engine, site = SiteEngine(s.Sites, rawUrl)
	}
	if engine == "" {
		engine = strings.ToLower(strings.TrimSpace(s.Default))
	}
	if engine == "" || engine == EngineApp {
		return Route{Engine: EngineApp, Site: site}
	}
	var browser *Browser
	reason := ""
	switch {
	case engine == EngineInstalled || engine == CustomBrowserId:
		browser, reason = Chosen(s.Installed, found)
	default:
		browser, reason = Chosen(engine, found)
	}
	if browser == nil {
		return Route{Engine: EngineApp, Site: site, Fallback: reason}
	}
	if !isWebUrl(rawUrl) {
		return Route{Engine: EngineApp, Site: site, Fallback: fmt.Sprintf("only web pages (http, https) open in %s", browser.Name)}
	}
	return Route{Engine: browser.Id, Browser: browser, Site: site}
}

// Command is the OS command that opens rawUrl in b, or that brings b to the front when rawUrl is empty (on Linux,
// where no generic call raises a window, it needs the page and opens it again).
func Command(goos string, b Browser, rawUrl string) (string, []string, error) {
	if goos == "darwin" {
		if rawUrl == "" {
			return "open", []string{"-a", b.Path}, nil
		}
		return "open", []string{"-a", b.Path, rawUrl}, nil
	}
	if rawUrl == "" {
		return "", nil, fmt.Errorf("%s cannot be brought to the front on this system", b.Name)
	}
	execLine, err := readDesktopExec(b.Path)
	if err != nil {
		return "", nil, err
	}
	argv, err := ExpandDesktopExec(execLine, rawUrl)
	if err != nil {
		return "", nil, fmt.Errorf("reading %s: %w", b.Path, err)
	}
	return argv[0], argv[1:], nil
}

func readDesktopExec(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	inEntry := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			inEntry = line == "[Desktop Entry]"
			continue
		}
		if inEntry && strings.HasPrefix(line, "Exec=") {
			return strings.TrimPrefix(line, "Exec="), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("%s has no Exec line", path)
}

// ExpandDesktopExec turns a desktop entry's Exec value into argv for rawUrl (Desktop Entry Specification): %u %U %f
// %F become the page, the other field codes are dropped, and the page is appended when the line takes no argument.
func ExpandDesktopExec(execLine string, rawUrl string) ([]string, error) {
	words, err := splitExec(execLine)
	if err != nil {
		return nil, err
	}
	var argv []string
	used := false
	for _, w := range words {
		switch w {
		case "%u", "%U", "%f", "%F":
			argv = append(argv, rawUrl)
			used = true
			continue
		case "%i", "%c", "%k", "%d", "%D", "%n", "%N", "%v", "%m":
			continue
		}
		argv = append(argv, strings.ReplaceAll(w, "%%", "%"))
	}
	if len(argv) == 0 {
		return nil, fmt.Errorf("empty Exec line")
	}
	if !used {
		argv = append(argv, rawUrl)
	}
	return argv, nil
}

func splitExec(line string) ([]string, error) {
	var words []string
	var cur strings.Builder
	inWord, quoted := false, false
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case quoted && c == '\\' && i+1 < len(line):
			i++
			cur.WriteByte(line[i])
		case c == '"':
			quoted = !quoted
			inWord = true
		case !quoted && (c == ' ' || c == '\t'):
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	if quoted {
		return nil, fmt.Errorf("unterminated quote in Exec line")
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, nil
}
