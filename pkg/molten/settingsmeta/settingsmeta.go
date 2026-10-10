// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package settingsmeta is what the settings screen knows about each key of settings.json (FR-SHELL-050,
// DS-SHELL-091): its section, group, label, one-line description and control. cmd/generateschema writes it into
// schema/settings.json as "x-moltenterm", next to the type and the description the add-config path already produces,
// and the screen reads it from there. A key added to wconfig.SettingsType without an entry here still shows, under
// Advanced, with its key as label; adding its entry moves it to its section. Hidden keys stay in the JSON file only.
package settingsmeta

const (
	SectionGeneral    = "general"
	SectionAppearance = "appearance"
	SectionTerminal   = "terminal"
	SectionAgents     = "agents"
	SectionBrowser    = "browser"
	SectionMission    = "mission"
	SectionKeyboard   = "keyboard"
	SectionAdvanced   = "advanced"
)

const (
	ControlToggle = "toggle"
	ControlSelect = "select"
	ControlNumber = "number"
	ControlSlider = "slider"
	ControlText   = "text"
	ControlPath   = "path"
	ControlMulti  = "multi"
	// An object or a list the screen does not edit: the row opens settings.json.
	ControlJSON = "json"
)

// Options filled by the screen at run time (the terminal themes come from the themes config).
const OptionsTermThemes = "termthemes"

var Sections = []string{
	SectionGeneral,
	SectionAppearance,
	SectionTerminal,
	SectionAgents,
	SectionBrowser,
	SectionMission,
	SectionKeyboard,
	SectionAdvanced,
}

var Controls = []string{
	ControlToggle,
	ControlSelect,
	ControlNumber,
	ControlSlider,
	ControlText,
	ControlPath,
	ControlMulti,
	ControlJSON,
}

type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type Range struct {
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
	Step float64 `json:"step"`
}

type Setting struct {
	Key         string   `json:"-"`
	Section     string   `json:"section,omitempty"`
	Group       string   `json:"group,omitempty"`
	Label       string   `json:"label,omitempty"`
	Description string   `json:"description,omitempty"`
	Control     string   `json:"control,omitempty"`
	Options     []Option `json:"options,omitempty"`
	OptionsFrom string   `json:"optionsfrom,omitempty"`
	// The label of the empty choice of a select whose key has no default ("Ask the first time").
	UnsetLabel string `json:"unsetlabel,omitempty"`
	Range      *Range `json:"range,omitempty"`
	Unit       string `json:"unit,omitempty"`
	// The value the app falls back to when the key is unset and pkg/wconfig/defaultconfig/settings.json has none.
	Default any `json:"default,omitempty"`
	// darwin, linux or windows, comma separated: the row shows on those platforms only.
	Platform string `json:"platform,omitempty"`
	Hidden   bool   `json:"hidden,omitempty"`
	Order    int    `json:"order"`
}

func rng(min, max, step float64) *Range {
	return &Range{Min: min, Max: max, Step: step}
}

func hidden(key string) Setting {
	return Setting{Key: key, Hidden: true}
}

var onOff = []Option{{Value: "off", Label: "Off"}, {Value: "on", Label: "On"}, {Value: "term", Label: "Terminals only"}}

// The order of the list is the order of the rows inside each section.
var settings = []Setting{
	// General
	{Key: "app:confirmquit", Section: SectionGeneral, Group: "Quitting and closing", Label: "Confirm before quitting", Description: "Ask before quitting MoltenTerm.", Control: ControlToggle},
	{Key: "window:confirmclose", Section: SectionGeneral, Group: "Quitting and closing", Label: "Confirm before closing a window", Description: "Ask before closing a window that holds several tabs.", Control: ControlToggle},
	{Key: "tab:confirmclose", Section: SectionGeneral, Group: "Quitting and closing", Label: "Confirm before closing a tab", Description: "Ask before closing a tab.", Control: ControlToggle},
	{Key: "tab:holdtoclose", Section: SectionGeneral, Group: "Quitting and closing", Label: "Hold to close a tab", Description: "A tab's close button closes it after a press-and-hold, not a single click.", Control: ControlToggle},
	{Key: "tab:holdtoclosems", Section: SectionGeneral, Group: "Quitting and closing", Label: "Hold duration", Description: "How long the close button is held before the tab closes.", Control: ControlNumber, Range: rng(200, 2000, 50), Unit: "ms"},
	{Key: "window:savelastwindow", Section: SectionGeneral, Group: "Startup", Label: "Reopen the last window", Description: "Closing the last window keeps it, so it opens again at the next launch.", Control: ControlToggle},
	{Key: "window:fullscreenonlaunch", Section: SectionGeneral, Group: "Startup", Label: "Full screen at launch", Description: "Open windows in full screen.", Control: ControlToggle},
	{Key: "app:tilelauncher", Section: SectionGeneral, Group: "Panels", Label: "Tile launcher in empty panes", Description: "An empty pane shows the tile launcher instead of the command palette.", Control: ControlToggle},
	{Key: "app:focusfollowscursor", Section: SectionGeneral, Group: "Panels", Label: "Focus follows the pointer", Description: "Focus the panel under the pointer without a click.", Control: ControlSelect, Options: onOff},
	{Key: "power:sleeppolicy", Section: SectionGeneral, Group: "Power", Label: "Keep the computer awake", Description: "Whether terminals may keep the computer awake (caffeinate, systemd-inhibit).", Control: ControlSelect, UnsetLabel: "Ask the first time", Options: []Option{{Value: "allow", Label: "When a terminal asks"}, {Value: "untilworkends", Label: "Until work ends"}, {Value: "letsleep", Label: "Never"}}},
	{Key: "preview:showhiddenfiles", Section: SectionGeneral, Group: "Files and editor", Label: "Show hidden files", Description: "File views list dotfiles.", Control: ControlToggle, Default: true},
	{Key: "preview:defaultsort", Section: SectionGeneral, Group: "Files and editor", Label: "Sort files by", Description: "The order of a file view's list.", Control: ControlSelect, Options: []Option{{Value: "name", Label: "Name"}, {Value: "modtime", Label: "Last modified"}}},
	{Key: "editor:wordwrap", Section: SectionGeneral, Group: "Files and editor", Label: "Wrap long lines", Description: "The editor wraps lines wider than the panel.", Control: ControlToggle},
	{Key: "editor:minimapenabled", Section: SectionGeneral, Group: "Files and editor", Label: "Minimap", Description: "Show the code overview on the editor's right edge.", Control: ControlToggle},
	{Key: "editor:stickyscrollenabled", Section: SectionGeneral, Group: "Files and editor", Label: "Sticky scroll", Description: "Keep the enclosing scopes at the top of the editor while scrolling.", Control: ControlToggle},
	{Key: "editor:inlinediff", Section: SectionGeneral, Group: "Files and editor", Label: "Inline diffs", Description: "Show diffs in one column instead of side by side.", Control: ControlToggle},

	// Appearance
	{Key: "window:reducedmotion", Section: SectionAppearance, Group: "Window", Label: "Reduce motion", Description: "Turn off animations, as the system's reduced motion setting does.", Control: ControlToggle},
	{Key: "window:tilegapsize", Section: SectionAppearance, Group: "Window", Label: "Gap between panels", Description: "The space between the panels of a tab.", Control: ControlNumber, Range: rng(0, 20, 1), Unit: "px"},
	{Key: "window:transparent", Section: SectionAppearance, Group: "Window", Label: "Transparent window", Description: "Let the desktop show through the window's background.", Control: ControlToggle},
	{Key: "window:blur", Section: SectionAppearance, Group: "Window", Label: "Blur behind the window", Description: "Blur the desktop behind a transparent window.", Control: ControlToggle},
	{Key: "window:opacity", Section: SectionAppearance, Group: "Window", Label: "Window opacity", Description: "How opaque a transparent or blurred window is.", Control: ControlSlider, Range: rng(0, 1, 0.05), Default: 0.8},
	{Key: "window:bgcolor", Section: SectionAppearance, Group: "Window", Label: "Window background", Description: "A CSS colour behind the panels, such as #1f1f1f.", Control: ControlText},
	{Key: "window:magnifiedblocksize", Section: SectionAppearance, Group: "Magnified panel", Label: "Magnified size", Description: "How much of the tab a magnified panel covers.", Control: ControlSlider, Range: rng(0.5, 1, 0.05)},
	{Key: "window:magnifiedblockopacity", Section: SectionAppearance, Group: "Magnified panel", Label: "Backdrop opacity", Description: "How much the panels behind a magnified panel fade.", Control: ControlSlider, Range: rng(0, 1, 0.05)},
	{Key: "editor:fontsize", Section: SectionAppearance, Group: "Text", Label: "Editor text size", Description: "The text size of file views and the editor.", Control: ControlNumber, Range: rng(6, 64, 1), Unit: "px", Default: 12},
	{Key: "markdown:fontsize", Section: SectionAppearance, Group: "Text", Label: "Markdown text size", Description: "The body text size of rendered Markdown.", Control: ControlNumber, Range: rng(6, 64, 1), Unit: "px"},
	{Key: "markdown:fixedfontsize", Section: SectionAppearance, Group: "Text", Label: "Markdown code size", Description: "The text size of code in rendered Markdown.", Control: ControlNumber, Range: rng(6, 64, 1), Unit: "px"},

	// Terminal
	{Key: "term:theme", Section: SectionTerminal, Group: "Look", Label: "Theme", Description: "The colours of every terminal without a theme of its own.", Control: ControlSelect, OptionsFrom: OptionsTermThemes, Default: "default-dark"},
	{Key: "term:fontsize", Section: SectionTerminal, Group: "Look", Label: "Font size", Description: "The text size of terminals.", Control: ControlNumber, Range: rng(6, 32, 1), Unit: "px", Default: 12},
	{Key: "term:fontfamily", Section: SectionTerminal, Group: "Look", Label: "Font", Description: "A monospace font installed on this computer, such as Hack.", Control: ControlText, Default: "Hack"},
	{Key: "term:cursor", Section: SectionTerminal, Group: "Look", Label: "Cursor", Description: "The shape of the terminal cursor.", Control: ControlSelect, Options: []Option{{Value: "block", Label: "Block"}, {Value: "bar", Label: "Bar"}, {Value: "underline", Label: "Underline"}}},
	{Key: "term:cursorblink", Section: SectionTerminal, Group: "Look", Label: "Blinking cursor", Description: "The cursor blinks.", Control: ControlToggle},
	{Key: "term:transparency", Section: SectionTerminal, Group: "Look", Label: "Transparency", Description: "How much of the window's background shows through a terminal.", Control: ControlSlider, Range: rng(0, 1, 0.05), Default: 0.5},
	{Key: "term:scrollback", Section: SectionTerminal, Group: "Behaviour", Label: "Scrollback", Description: "How many lines of output a terminal keeps.", Control: ControlNumber, Range: rng(0, 50000, 500), Unit: "lines", Default: 2000},
	{Key: "term:copyonselect", Section: SectionTerminal, Group: "Behaviour", Label: "Copy on select", Description: "Selecting text copies it.", Control: ControlToggle},
	{Key: "term:trimtrailingwhitespace", Section: SectionTerminal, Group: "Behaviour", Label: "Trim copied lines", Description: "Copying drops the spaces at the end of each line.", Control: ControlToggle},
	{Key: "term:allowbracketedpaste", Section: SectionTerminal, Group: "Behaviour", Label: "Bracketed paste", Description: "Programs can tell pasted text from typed text.", Control: ControlToggle, Default: true},
	{Key: "term:osc52", Section: SectionTerminal, Group: "Behaviour", Label: "Clipboard access", Description: "When programs in a terminal may write to the clipboard (OSC 52).", Control: ControlSelect, Options: []Option{{Value: "always", Label: "Always"}, {Value: "focus", Label: "When the terminal is focused"}}},
	{Key: "term:bellsound", Section: SectionTerminal, Group: "Behaviour", Label: "Bell sound", Description: "Play a sound when a program rings the bell.", Control: ControlToggle},
	{Key: "term:bellindicator", Section: SectionTerminal, Group: "Behaviour", Label: "Bell indicator", Description: "Mark the tab when a program rings the bell.", Control: ControlToggle},
	{Key: "term:durable", Section: SectionTerminal, Group: "Behaviour", Label: "Durable sessions", Description: "New terminals keep running when MoltenTerm quits or updates.", Control: ControlToggle},
	{Key: "term:localshellpath", Section: SectionTerminal, Group: "Shell", Label: "Shell", Description: "The shell local terminals start, such as /bin/zsh; empty uses your login shell.", Control: ControlPath},
	{Key: "term:localshellopts", Section: SectionTerminal, Group: "Shell", Label: "Shell arguments", Description: "The arguments passed to the local shell.", Control: ControlJSON},
	{Key: "term:gitbashpath", Section: SectionTerminal, Group: "Shell", Label: "Git Bash", Description: "Where Git Bash is installed.", Control: ControlPath, Platform: "windows"},
	{Key: "conn:wshenabled", Section: SectionTerminal, Group: "Connections", Label: "Shell integration on remotes", Description: "Install MoltenTerm's helper on SSH hosts, for file views and folder tracking.", Control: ControlToggle},
	{Key: "conn:askbeforewshinstall", Section: SectionTerminal, Group: "Connections", Label: "Ask before installing it", Description: "Ask before installing the helper on a new host.", Control: ControlToggle},
	{Key: "conn:localhostdisplayname", Section: SectionTerminal, Group: "Connections", Label: "Name of this computer", Description: "How the local connection is named in headers and menus.", Control: ControlText},

	// Agents
	{Key: "companion:usagegauges", Section: SectionAgents, Group: "Companion", Label: "Plan usage", Description: "The agents whose plan usage the companion shows.", Control: ControlMulti, Options: []Option{{Value: "claude", Label: "Claude Code"}, {Value: "codex", Label: "Codex"}}},
	{Key: "agent:sessionroots", Section: SectionAgents, Group: "Companion", Label: "More session folders", Description: "Extra configuration folders per agent whose sessions the companion reads.", Control: ControlJSON},

	// Browser
	{Key: "browser:default", Section: SectionBrowser, Group: "Opening pages", Label: "Open web pages in", Description: "Where links and web pages open by default.", Control: ControlSelect, UnsetLabel: "Ask for each site", Options: []Option{{Value: "app", Label: "MoltenTerm's browser"}, {Value: "installed", Label: "The installed browser"}}},
	{Key: "browser:installed", Section: SectionBrowser, Group: "Opening pages", Label: "Installed browser", Description: "The Chromium browser pages are handed off to.", Control: ControlSelect, UnsetLabel: "First one found", Options: []Option{{Value: "chrome", Label: "Chrome"}, {Value: "brave", Label: "Brave"}, {Value: "edge", Label: "Edge"}, {Value: "arc", Label: "Arc"}, {Value: "vivaldi", Label: "Vivaldi"}, {Value: "opera", Label: "Opera"}, {Value: "chromium", Label: "Chromium"}}},
	{Key: "web:openlinksinternally", Section: SectionBrowser, Group: "Opening pages", Label: "Open links in MoltenTerm", Description: "Links clicked in a terminal or a page open in a browser panel.", Control: ControlToggle},
	{Key: "browser:sites", Section: SectionBrowser, Group: "Opening pages", Label: "Per-site browser", Description: "Sites that always open in MoltenTerm's browser or the installed one.", Control: ControlJSON},
	{Key: "web:defaulturl", Section: SectionBrowser, Group: "Browser panel", Label: "Home page", Description: "The page a new browser panel opens.", Control: ControlText},
	{Key: "web:defaultsearch", Section: SectionBrowser, Group: "Browser panel", Label: "Search engine", Description: "The search URL, with {query} where the words go.", Control: ControlText},
	{Key: "browser:agentsites", Section: SectionBrowser, Group: "Agents", Label: "Agent site permissions", Description: "Sites agents may use or are blocked from in the browser panel.", Control: ControlJSON},

	// Mission Control
	{Key: "linemap:animation", Section: SectionMission, Group: "Line map", Label: "Animate the line map", Description: "Play the load sequence and the moving trains; reduced motion turns it off.", Control: ControlToggle, Default: true},
	{Key: "cicd:runs", Section: SectionMission, Group: "CI/CD", Label: "Runs shown", Description: "Which runs a CI/CD panel shows first.", Control: ControlSelect, Default: "remote", Options: []Option{{Value: "local", Label: "Local CI"}, {Value: "remote", Label: "Remote CI"}, {Value: "cd", Label: "CD"}}},

	// Keyboard
	{Key: "app:globalhotkey", Section: SectionKeyboard, Group: "Keys", Label: "Global shortcut", Description: "A system-wide shortcut that brings MoltenTerm to the front.", Control: ControlText},
	{Key: "term:macoptionismeta", Section: SectionKeyboard, Group: "Keys", Label: "Option is Meta", Description: "The Option key sends Meta to terminal programs instead of typing symbols.", Control: ControlToggle, Platform: "darwin"},
	{Key: "term:shiftenternewline", Section: SectionKeyboard, Group: "Keys", Label: "Shift+Enter inserts a line", Description: "Shift+Enter sends a new line instead of Enter.", Control: ControlToggle},
	{Key: "app:ctrlvpaste", Section: SectionKeyboard, Group: "Keys", Label: "Ctrl+V pastes", Description: "Ctrl+V pastes in terminals instead of reaching the program.", Control: ControlToggle},
	{Key: "app:disablectrlshiftarrows", Section: SectionKeyboard, Group: "Keys", Label: "No Ctrl+Shift+arrow navigation", Description: "Ctrl+Shift+arrows reach the program instead of moving between panels.", Control: ControlToggle},
	{Key: "app:disablectrlshiftdisplay", Section: SectionKeyboard, Group: "Keys", Label: "No panel numbers on Ctrl+Shift", Description: "Holding Ctrl+Shift does not show the panels' numbers.", Control: ControlToggle},
	{Key: "app:showoverlayblocknums", Section: SectionKeyboard, Group: "Keys", Label: "Panel numbers", Description: "Show each panel's number while its shortcut keys are held.", Control: ControlToggle, Default: true},

	// Advanced: real settings few people change.
	{Key: "app:nativecontextmenu", Section: SectionAdvanced, Group: "App", Label: "System context menus", Description: "Use the system's context menus instead of MoltenTerm's.", Control: ControlToggle},
	{Key: "app:defaultnewblock", Section: SectionAdvanced, Group: "App", Label: "New tab content", Description: "The view a new tab starts with, such as term.", Control: ControlText},
	{Key: "app:tabbar", Section: SectionAdvanced, Group: "App", Label: "Tab bar position", Description: "Where the tab bar sits.", Control: ControlSelect, Options: []Option{{Value: "top", Label: "Top"}, {Value: "left", Label: "Left"}}},
	{Key: "feature:waveappbuilder", Section: SectionAdvanced, Group: "App", Label: "App builder", Description: "Show the Apps tool in the rail outside development builds.", Control: ControlToggle},
	{Key: "tab:preset", Section: SectionAdvanced, Group: "App", Label: "Tab preset", Description: "The preset new tabs start from.", Control: ControlText},
	{Key: "tab:background", Section: SectionAdvanced, Group: "App", Label: "Tab background", Description: "The background new tabs get, from backgrounds.json.", Control: ControlText},
	{Key: "window:nativetitlebar", Section: SectionAdvanced, Group: "Window", Label: "Native title bar", Description: "Use the system's title bar.", Control: ControlToggle, Platform: "linux,windows"},
	{Key: "window:showmenubar", Section: SectionAdvanced, Group: "Window", Label: "Menu bar", Description: "Show the menu bar in the window.", Control: ControlToggle, Platform: "linux,windows"},
	{Key: "window:zoom", Section: SectionAdvanced, Group: "Window", Label: "Zoom", Description: "The zoom of the window's content; ⌘+ and ⌘- change it.", Control: ControlNumber, Range: rng(0.4, 2.6, 0.1), Default: 1},
	{Key: "window:disablehardwareacceleration", Section: SectionAdvanced, Group: "Window", Label: "No hardware acceleration", Description: "Draw without the GPU; takes effect at the next launch.", Control: ControlToggle},
	{Key: "window:maxtabcachesize", Section: SectionAdvanced, Group: "Window", Label: "Tabs kept in memory", Description: "How many tabs stay loaded in the background.", Control: ControlNumber, Range: rng(1, 50, 1)},
	{Key: "window:magnifiedblockblurprimarypx", Section: SectionAdvanced, Group: "Window", Label: "Magnified backdrop blur", Description: "The blur behind a magnified panel.", Control: ControlNumber, Range: rng(0, 40, 1), Unit: "px"},
	{Key: "window:magnifiedblockblursecondarypx", Section: SectionAdvanced, Group: "Window", Label: "Secondary backdrop blur", Description: "The blur behind the other layers of a magnified panel.", Control: ControlNumber, Range: rng(0, 40, 1), Unit: "px"},
	{Key: "window:dimensions", Section: SectionAdvanced, Group: "Window", Label: "New window size", Description: "The size of new windows, such as 1400x900.", Control: ControlText},
	{Key: "term:disablewebgl", Section: SectionAdvanced, Group: "Terminal", Label: "No WebGL in terminals", Description: "Draw terminals without WebGL, slower but safer on some GPUs.", Control: ControlToggle},
	{Key: "term:showsplitbuttons", Section: SectionAdvanced, Group: "Terminal", Label: "Split buttons in headers", Description: "Show split buttons in terminal headers.", Control: ControlToggle},
	{Key: "companion:usageclaudeoauth", Section: SectionAdvanced, Group: "Agents", Label: "Claude Code limits (experimental)", Description: "Read Claude Code's limits from Anthropic's undocumented endpoint with its own sign-in.", Control: ControlToggle},
	{Key: "debug:pprofport", Section: SectionAdvanced, Group: "Debugging", Label: "Profiler port", Description: "Serve Go's pprof on this port.", Control: ControlNumber, Range: rng(0, 65535, 1)},
	{Key: "debug:pprofmemprofilerate", Section: SectionAdvanced, Group: "Debugging", Label: "Memory profile rate", Description: "Go's memory profile sampling rate.", Control: ControlNumber, Range: rng(0, 1048576, 1)},
	{Key: "debug:webglstatus", Section: SectionAdvanced, Group: "Debugging", Label: "WebGL status", Description: "Show whether each terminal draws with WebGL.", Control: ControlToggle},
	{Key: "tsunami:scaffoldpath", Section: SectionAdvanced, Group: "App builder", Label: "Scaffold path", Description: "Where the app builder's scaffold lives.", Control: ControlPath},
	{Key: "tsunami:sdkreplacepath", Section: SectionAdvanced, Group: "App builder", Label: "SDK replace path", Description: "A local SDK used in place of the published one.", Control: ControlPath},
	{Key: "tsunami:sdkversion", Section: SectionAdvanced, Group: "App builder", Label: "SDK version", Description: "The SDK version apps build against.", Control: ControlText},
	{Key: "tsunami:gopath", Section: SectionAdvanced, Group: "App builder", Label: "Go binary", Description: "The Go binary apps build with.", Control: ControlPath},

	// Hidden: namespace resets (only meaningful in the JSON file), Wave's inert updater (MoltenTerm has its own update
	// flow, #5), telemetry (forced off, FR-FORK-003) and Wave-only surfaces MoltenTerm does not show.
	hidden("app:*"),
	hidden("term:*"),
	hidden("web:*"),
	hidden("autoupdate:*"),
	hidden("widget:*"),
	hidden("window:*"),
	hidden("telemetry:*"),
	hidden("conn:*"),
	hidden("debug:*"),
	hidden("tsunami:*"),
	hidden("autoupdate:enabled"),
	hidden("autoupdate:intervalms"),
	hidden("autoupdate:installonquit"),
	hidden("autoupdate:channel"),
	hidden("telemetry:enabled"),
	hidden("widget:showhelp"),
	hidden("app:dismissarchitecturewarning"),
}

func init() {
	for i := range settings {
		settings[i].Order = i
	}
}

// All returns the entries in screen order.
func All() []Setting {
	rtn := make([]Setting, len(settings))
	copy(rtn, settings)
	return rtn
}

// Lookup returns the entry of key and whether it has one.
func Lookup(key string) (Setting, bool) {
	for _, s := range settings {
		if s.Key == key {
			return s, true
		}
	}
	return Setting{}, false
}
