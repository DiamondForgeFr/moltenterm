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
