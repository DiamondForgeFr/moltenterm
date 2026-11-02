// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package versions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const packageJson = `{
  "name": "moltenterm",
  "version": "0.14.5",
  "scripts": { "version": "node version.cjs" },
  "build": { "appId": "x" }
}
`

const packageLock = `{
    "name": "moltenterm",
    "version": "0.14.5",
    "lockfileVersion": 3,
    "packages": {
        "": {
            "name": "moltenterm",
            "version": "0.14.5"
        },
        "node_modules/a": { "version": "1.2.3" }
    }
}
`

const cargoToml = `[package]
name = "app"
version = "0.14.5"

[dependencies]
serde = { version = "1.0" }
`

var testFiles = []VersionFile{
	{Path: "package.json", Format: FileFormatJson, Keys: [][]string{{"version"}}},
	{Path: "package-lock.json", Format: FileFormatJson, Keys: [][]string{{"version"}, {"packages", "", "version"}}},
	{Path: "src-tauri/Cargo.toml", Format: FileFormatRegex, Pattern: `(?m)^version = "([^"]+)"`},
}

func writeTestProject(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range map[string]string{
		"package.json":         packageJson,
		"package-lock.json":    packageLock,
		"src-tauri/Cargo.toml": cargoToml,
	} {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestReadVersion(t *testing.T) {
	dir := writeTestProject(t)
	got, err := ReadVersion(dir, testFiles)
	if err != nil || got != "0.14.5" {
		t.Fatalf("ReadVersion = %q, %v", got, err)
	}
	values, err := ReadFileVersions(dir, testFiles[1])
	if err != nil || strings.Join(values, ",") != "0.14.5,0.14.5" {
		t.Fatalf("package-lock = %v, %v", values, err)
	}
}

func TestWriteVersionKeepsTheRest(t *testing.T) {
	dir := writeTestProject(t)
	if err := WriteVersion(dir, testFiles, "1.0.0-0"); err != nil {
		t.Fatal(err)
	}
	read := func(name string) string {
		data, _ := os.ReadFile(filepath.Join(dir, name))
		return string(data)
	}
	if got, want := read("package.json"), strings.Replace(packageJson, `"version": "0.14.5"`, `"version": "1.0.0-0"`, 1); got != want {
		t.Errorf("package.json:\n%s", got)
	}
	if got, want := read("package-lock.json"), strings.ReplaceAll(packageLock, `"version": "0.14.5"`, `"version": "1.0.0-0"`); got != want {
		t.Errorf("package-lock.json:\n%s", got)
	}
	if got, want := read("src-tauri/Cargo.toml"), strings.Replace(cargoToml, `version = "0.14.5"`, `version = "1.0.0-0"`, 1); got != want {
		t.Errorf("Cargo.toml:\n%s", got)
	}
}

func TestVersionFileRefusals(t *testing.T) {
	dir := writeTestProject(t)
	cases := []struct {
		file VersionFile
		want string
	}{
		{VersionFile{Path: "package.json", Format: FileFormatJson, Keys: [][]string{{"missing"}}}, `["missing"] is missing`},
		{VersionFile{Path: "package.json", Format: FileFormatJson, Keys: [][]string{{"build"}}}, `["build"] is missing`},
		{VersionFile{Path: "package-lock.json", Format: FileFormatJson, Keys: [][]string{{"lockfileVersion"}}}, "is not a string"},
		{VersionFile{Path: "package.json", Format: FileFormatJson}, "keys is empty"},
		{VersionFile{Path: "package.json", Format: "toml"}, "format must be"},
		{VersionFile{Path: "src-tauri/Cargo.toml", Format: FileFormatRegex, Pattern: `version = "([^"]+)"`}, "exactly once (it matches 2 times)"},
		{VersionFile{Path: "src-tauri/Cargo.toml", Format: FileFormatRegex, Pattern: `^name`}, "exactly one capture group"},
		{VersionFile{Path: "nope.json", Format: FileFormatJson, Keys: [][]string{{"version"}}}, "no such file"},
	}
	for _, c := range cases {
		err := CheckFile(dir, c.file)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: got %v, want %q", c.file, err, c.want)
		}
	}
}

func TestWriteVersionRefusesWhatItCannotWrite(t *testing.T) {
	dir := writeTestProject(t)
	if err := WriteVersion(dir, testFiles, `1.0.0"`); err == nil {
		t.Error("a quote in a version must be refused")
	}
	bad := append([]VersionFile{}, testFiles[0], VersionFile{Path: "package.json", Format: FileFormatJson, Keys: [][]string{{"nope"}}})
	if err := WriteVersion(dir, bad, "1.0.0-0"); err == nil {
		t.Error("a missing key must be refused")
	}
}

const readmeMd = "# App\n\n**v0.14.5**\n\nCurrent version: 0.14.5-beta (npm package `app`).\nThe changelog mentions 0.14.4.\n"

func TestTextLabels(t *testing.T) {
	dir := writeTestProject(t)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readmeMd), 0644); err != nil {
		t.Fatal(err)
	}
	files := []VersionFile{
		testFiles[0],
		{Path: "README.md", Format: FileFormatText, Pattern: `\*\*v{version}\*\*`},
		{Path: "README.md", Format: FileFormatText, Pattern: TextLabelPattern("Current version: ", " (npm package `app`).")},
	}
	values, err := ReadFileVersions(dir, files[2])
	if err != nil || strings.Join(values, ",") != "0.14.5-beta" {
		t.Fatalf("label = %v, %v", values, err)
	}
	if err := WriteVersion(dir, files, "1.0.0-1"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "README.md"))
	want := strings.NewReplacer("**v0.14.5**", "**v1.0.0-1**", "0.14.5-beta", "1.0.0-1").Replace(readmeMd)
	if string(data) != want {
		t.Errorf("README.md:\n%s", data)
	}
}

func TestTextLabelRefusals(t *testing.T) {
	dir := writeTestProject(t)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readmeMd), 0644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		pattern string
		want    string
	}{
		{`\*\*v0\.14\.5\*\*`, "{version} exactly once"},
		{`{version}{version}`, "{version} exactly once"},
		{`(v){version}`, "no capture group of its own"},
		{`{version}`, "exactly once (it matches 3 times)"},
		{`nothing {version}`, "exactly once (it matches 0 times)"},
		{`[{version}`, "pattern:"},
	}
	for _, c := range cases {
		err := CheckFile(dir, VersionFile{Path: "README.md", Format: FileFormatText, Pattern: c.pattern})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%q: got %v, want %q", c.pattern, err, c.want)
		}
	}
}
