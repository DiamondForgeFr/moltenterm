// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// The settings and sign-in folders an uninstall removes when ticked (#1699) go to the system trash, never deleted:
// the developer can take them back. macOS's trash is ~/.Trash; Linux's is the freedesktop trash (files/ and the
// .trashinfo that lets the file manager put it back). A move that fails stops there and says which: what was moved
// stays in the trash, the rest stays where it was.

func trashDir(home string) (string, error) {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, ".Trash"), nil
	case "linux":
		data := os.Getenv("XDG_DATA_HOME")
		if data == "" || !strings.HasPrefix(data, home) {
			data = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(data, "Trash"), nil
	}
	return "", fmt.Errorf("no system trash known on %s", runtime.GOOS)
}

// freeName is name, or name with a number, that does not exist in dir yet.
func freeName(dir string, name string, taken func(string) bool) string {
	if !taken(name) {
		return name
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s %d", name, i)
		if !taken(candidate) {
			return candidate
		}
	}
}

// moveToTrash moves path into the trash and returns where it went.
func moveToTrash(home string, path string) (string, error) {
	trash, err := trashDir(home)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		if err := os.MkdirAll(trash, 0700); err != nil {
			return "", err
		}
		name := freeName(trash, filepath.Base(path), func(n string) bool {
			_, err := os.Lstat(filepath.Join(trash, n))
			return err == nil
		})
		dest := filepath.Join(trash, name)
		return dest, os.Rename(path, dest)
	}
	files := filepath.Join(trash, "files")
	info := filepath.Join(trash, "info")
	for _, d := range []string{files, info} {
		if err := os.MkdirAll(d, 0700); err != nil {
			return "", err
		}
	}
	name := freeName(files, filepath.Base(path), func(n string) bool {
		_, errFile := os.Lstat(filepath.Join(files, n))
		_, errInfo := os.Lstat(filepath.Join(info, n+".trashinfo"))
		return errFile == nil || errInfo == nil
	})
	infoPath := filepath.Join(info, name+".trashinfo")
	escaped := (&url.URL{Path: path}).EscapedPath()
	content := fmt.Sprintf("[Trash Info]\nPath=%s\nDeletionDate=%s\n", escaped, time.Now().Format("2006-01-02T15:04:05"))
	if err := os.WriteFile(infoPath, []byte(content), 0600); err != nil {
		return "", err
	}
	dest := filepath.Join(files, name)
	if err := os.Rename(path, dest); err != nil {
		os.Remove(infoPath)
		return "", err
	}
	return dest, nil
}

type trashFailure struct {
	Path string
	Err  error
}

func (f *trashFailure) Error() string {
	return fmt.Sprintf("%s could not be moved to the trash: %v", f.Path, f.Err)
}

// trashAll moves the paths that exist, in order, and stops at the first that cannot move. It returns the paths moved
// (as the developer knows them, ~/... kept) and the failure.
func trashAll(home string, paths []string) ([]string, *trashFailure) {
	var moved []string
	for _, p := range paths {
		full := homePath(home, p)
		if _, err := os.Lstat(full); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return moved, &trashFailure{Path: p, Err: err}
		}
		if _, err := moveToTrash(home, full); err != nil {
			return moved, &trashFailure{Path: p, Err: err}
		}
		moved = append(moved, p)
	}
	return moved, nil
}
