// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
)

// One copy rule (DS-MAT-003): a material is copied when it is seen, if it fits; otherwise it is a reference to its
// original that says why. A full cap never deletes anything: the new material is a reference.

const (
	gitTimeout = 5 * time.Second
	// A page's own text read for its linked files.
	pageScanBytes = 4 * 1024 * 1024
	// A tool's version number further than this past the latest copy is not believed.
	maxVersionSkip = 1000
)

// Limits are the registry's limits (AC9 of FR-MAT-001); FR-MAT-005 makes them adjustable.
type Limits struct {
	AutoCopy      int64
	RequestedCopy int64
	ProjectCap    int64
	TotalCap      int64
	MaxVersions   int
	MaxLinked     int
	TrashKeep     time.Duration
	ThumbPx       int
	ThumbBytes    int
}

func DefaultLimits() Limits {
	return Limits{
		AutoCopy:      25 << 20,
		RequestedCopy: 500 << 20,
		ProjectCap:    500 << 20,
		TotalCap:      2 << 30,
		MaxVersions:   5,
		MaxLinked:     300,
		TrashKeep:     30 * 24 * time.Hour,
		ThumbPx:       640,
		ThumbBytes:    200 << 10,
	}
}

var (
	pageRefRegex = regexp.MustCompile(`(?i)\b(?:src|href|poster|data-src)\s*=\s*["']([^"'<>]+)["']`)
	srcsetRegex  = regexp.MustCompile(`(?i)\bsrcset\s*=\s*["']([^"'<>]+)["']`)
	cssUrlRegex  = regexp.MustCompile(`(?i)url\(\s*["']?([^"')]+)["']?\s*\)`)
)

// Capture is one sighting of a material.
type Capture struct {
	Project     string
	Folder      string
	Source      string
	Path        string
	Link        string
	ToolTitle   string
	ArtifactId  string
	Linked      []string
	Sources     map[string]string
	Requested   bool
	AllowSecret bool
	// Recopy: the end-of-turn copy; it replaces the latest version's files when they changed, and adds nothing new.
	Recopy bool
	// Version: the page's version number at its address, as the publishing tool gives it (0: not given).
	Version     int
	Agent       string
	Tool        string
	SessionId   string
	Subject     string
	Ticket      int
	WorkspaceId string
	BlockId     string
}

type plannedFile struct {
	src  string
	rel  string
	size int64
}

type pendingVersion struct {
	tmp   string
	hash  string
	size  int64
	files int
	main  string
	thumb []byte
}

// ErrNotMaterial is a path or address that is never a material (forbidden, tracked by git, not a kept type).
var ErrNotMaterial = errors.New("not a material")

func notMaterial(why string) error {
	return fmt.Errorf("%w: %s", ErrNotMaterial, why)
}

// gitOutside tells whether a file is outside any repository's tracked or trackable files: not in a git tree, or
// ignored by it. Read-only, without a lock.
func gitOutside(path string) bool {
	root := molten.FindGitRoot(filepath.Dir(path))
	if root == "" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := spawns.Command(ctx, "git", "--no-optional-locks", "check-ignore", "-q", "--", path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	return cmd.Run() == nil
}

// capture records a sighting: a new material, a new version of one already known, or nothing new.
func (r *Registry) capture(c Capture) (molten.Material, bool, error) {
	link := ""
	if c.Link != "" {
		cleaned, ok := CleanAddress(c.Link)
		if ok {
			link = cleaned
		} else if c.Path == "" {
			return molten.Material{}, false, notMaterial("an address that is not kept (not http, or signed and expiring)")
		}
	}
	real, kind, original, state, err := r.resolveSource(c.Path, link != "")
	if err != nil {
		return molten.Material{}, false, err
	}
	if kind == "" {
		kind = molten.MaterialKindLink
	}
	existing, found := r.store.match(c.Project, c.ArtifactId, link, original)
	if c.Recopy && !found {
		return molten.Material{}, false, nil
	}
	var ver *pendingVersion
	var size int64
	if real != "" {
		files, total := r.planFiles(real, kind, c.Linked, c.Sources)
		size = total
		limit := r.limits.AutoCopy
		if c.Requested {
			limit = r.limits.RequestedCopy
		}
		switch {
		case total > limit:
			state = molten.MaterialCopyTooLarge
		case !c.AllowSecret && filesHoldSecret(files):
			state = molten.MaterialCopySecret
		case !r.store.fits(c.Project, total, r.limits):
			state = molten.MaterialCopySpaceFull
		default:
			ver, err = r.store.buildVersion(c.Project, files, kind, r.limits)
			if err != nil {
				state = molten.MaterialCopyFailed
				ver = nil
			}
		}
	}
	title := AutoTitle(kind, real, link, c.ToolTitle, c.Subject)
	rec := molten.Material{
		Project: c.Project, Title: title, Kind: kind, Source: c.Source, Link: link, ArtifactId: c.ArtifactId,
		Original: original, MayBeLost: original != "" && r.guard.mayBeLost(original), Copy: state, Size: size,
		Agent: c.Agent, Tool: c.Tool, SessionId: c.SessionId, Subject: cleanTitle(c.Subject), Ticket: c.Ticket,
		WorkspaceId: c.WorkspaceId, BlockId: c.BlockId,
	}
	if original != "" {
		rec.OriginalName = filepath.Base(original)
	}
	existingId := ""
	if found {
		existingId = existing.Id
	}
	return r.store.commit(c.Project, c.Folder, existingId, rec, ver, commitOpts{recopy: c.Recopy, toolTitle: c.ToolTitle != "", version: c.Version}, r.limits)
}

// resolveSource checks a material's file: it returns its real path and kind when it may be copied, the original path
// to record, and the copy state when it cannot be copied. A path that is never a material is refused unless the
// material has an address, which is then kept alone.
func (r *Registry) resolveSource(path string, hasLink bool) (string, string, string, string, error) {
	if path == "" {
		return "", "", "", "", nil
	}
	refuse := func(err error) (string, string, string, string, error) {
		if hasLink {
			return "", "", "", "", nil
		}
		return "", "", "", "", err
	}
	if !filepath.IsAbs(path) {
		return refuse(notMaterial("not an absolute path"))
	}
	clean := filepath.Clean(path)
	if why := r.guard.forbidden(realOrClean(clean)); why != "" {
		return refuse(notMaterial(why))
	}
	kind := KindOfPath(clean)
	if kind == "" {
		return refuse(notMaterial("not a kind of file Materials keeps"))
	}
	real, _, err := r.guard.resolveFile(clean)
	if err != nil {
		if strings.HasPrefix(err.Error(), "never kept") {
			return refuse(notMaterial(err.Error()))
		}
		if hasLink {
			return "", kind, clean, molten.MaterialCopyMissing, nil
		}
		return "", "", "", "", fmt.Errorf("%s: %w", clean, err)
	}
	if KindOfPath(real) == "" {
		return refuse(notMaterial("not a kind of file Materials keeps"))
	}
	if !r.outside(real) {
		return refuse(notMaterial("a file of the repository"))
	}
	return real, kind, real, "", nil
}

// planFiles lists what a copy holds: the file, and for a page its linked files (the publishing tool's list and the
// page's own relative references), at most MaxLinked, each through the forbidden-path guard.
func (r *Registry) planFiles(real string, kind string, linked []string, sources map[string]string) ([]plannedFile, int64) {
	info, err := os.Stat(real)
	if err != nil {
		return nil, 0
	}
	main := plannedFile{src: real, rel: filepath.Base(real), size: info.Size()}
	files := []plannedFile{main}
	total := main.size
	if kind != molten.MaterialKindPage {
		return files, total
	}
	pageDir := filepath.Dir(real)
	seen := map[string]bool{main.rel: true}
	add := func(rel string, src string) {
		if len(files)-1 >= r.limits.MaxLinked {
			return
		}
		rel = filepath.Clean(filepath.FromSlash(rel))
		if !filepath.IsLocal(rel) || seen[rel] || !linkedAllowed(rel) {
			return
		}
		if src == "" {
			src = filepath.Join(pageDir, rel)
		} else if !filepath.IsAbs(src) {
			src = filepath.Join(pageDir, src)
		}
		if !linkedAllowed(src) {
			return
		}
		resolved, fi, err := r.guard.resolveFile(src)
		if err != nil {
			return
		}
		seen[rel] = true
		files = append(files, plannedFile{src: resolved, rel: rel, size: fi.Size()})
		total += fi.Size()
	}
	for _, rel := range linked {
		add(rel, sources[rel])
	}
	var css []string
	for _, ref := range pageRefs(readLimited(real, pageScanBytes)) {
		before := len(files)
		add(ref, "")
		if len(files) > before && strings.EqualFold(filepath.Ext(ref), ".css") {
			css = append(css, filepath.Clean(filepath.FromSlash(ref)))
		}
	}
	for _, rel := range css {
		for _, ref := range cssRefs(readLimited(filepath.Join(pageDir, rel), pageScanBytes)) {
			add(filepath.Join(filepath.Dir(rel), filepath.FromSlash(ref)), "")
		}
	}
	return files, total
}

func readLimited(path string, max int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	data, _ := io.ReadAll(io.LimitReader(f, max))
	return string(data)
}

// localRef keeps a reference to a file next to the page: no scheme, no data:, no root-relative path, no query.
func localRef(ref string) (string, bool) {
	ref = strings.TrimSpace(ref)
	if i := strings.IndexAny(ref, "?#"); i >= 0 {
		ref = ref[:i]
	}
	if ref == "" || strings.HasPrefix(ref, "/") || strings.HasPrefix(ref, "\\") || strings.Contains(ref, ":") {
		return "", false
	}
	if decoded, err := url.PathUnescape(ref); err == nil {
		ref = decoded
	}
	return ref, true
}

func pageRefs(text string) []string {
	var rtn []string
	for _, m := range pageRefRegex.FindAllStringSubmatch(text, -1) {
		if ref, ok := localRef(m[1]); ok {
			rtn = append(rtn, ref)
		}
	}
	for _, m := range srcsetRegex.FindAllStringSubmatch(text, -1) {
		for _, part := range strings.Split(m[1], ",") {
			fields := strings.Fields(part)
			if len(fields) == 0 {
				continue
			}
			if ref, ok := localRef(fields[0]); ok {
				rtn = append(rtn, ref)
			}
		}
	}
	return append(rtn, cssRefs(text)...)
}

func cssRefs(text string) []string {
	var rtn []string
	for _, m := range cssUrlRegex.FindAllStringSubmatch(text, -1) {
		if ref, ok := localRef(m[1]); ok {
			rtn = append(rtn, ref)
		}
	}
	return rtn
}

// filesHoldSecret runs the secret detection on the text files of a copy (AC13): binary files only pass the path guard.
func filesHoldSecret(files []plannedFile) bool {
	for _, f := range files {
		if !isText(f.src) {
			continue
		}
		if hasSecret(readLimited(f.src, f.size+1)) {
			return true
		}
	}
	return false
}

// buildVersion copies the files under the drawer's .tmp/, hashing them; the folder becomes a version only when the
// commit renames it into the item.
func (s *Store) buildVersion(key string, files []plannedFile, kind string, limits Limits) (*pendingVersion, error) {
	if len(files) == 0 {
		return nil, fmt.Errorf("nothing to copy")
	}
	base := filepath.Join(s.drawerDir(key), tmpDir)
	if err := ensureDir(s.drawerDir(key)); err != nil {
		return nil, err
	}
	if err := ensureDir(base); err != nil {
		return nil, err
	}
	tmp := filepath.Join(base, randomSuffix()+randomSuffix())
	if err := os.Mkdir(tmp, dirMode); err != nil {
		return nil, err
	}
	fail := func(err error) (*pendingVersion, error) {
		os.RemoveAll(tmp)
		return nil, err
	}
	sort.SliceStable(files[1:], func(i, j int) bool { return files[1+i].rel < files[1+j].rel })
	h := sha256.New()
	var size int64
	for i, f := range files {
		dst := filepath.Join(tmp, f.rel)
		if err := os.MkdirAll(filepath.Dir(dst), dirMode); err != nil {
			return fail(err)
		}
		var data []byte
		var err error
		if i == 0 && kind == molten.MaterialKindImage && strings.EqualFold(filepath.Ext(f.src), ".svg") {
			data, err = sanitizedSvg(f.src, f.size)
			if err != nil {
				return fail(err)
			}
		}
		n, err := copyFile(f.src, dst, f.size, data, h, f.rel)
		if err != nil {
			return fail(err)
		}
		size += n
		s.kill("copy:file")
	}
	v := &pendingVersion{tmp: tmp, hash: hex.EncodeToString(h.Sum(nil))[:32], size: size, files: len(files) - 1, main: files[0].rel}
	if kind == molten.MaterialKindImage {
		v.thumb = makeThumb(filepath.Join(tmp, files[0].rel), limits.ThumbPx, limits.ThumbBytes)
	}
	return v, nil
}

// copyFile copies a file (or the given bytes) into a new 0600 file, adding it to the hash; a file that grew past what
// was planned is cut there.
func copyFile(src string, dst string, planned int64, data []byte, h io.Writer, rel string) (int64, error) {
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
	if err != nil {
		return 0, err
	}
	io.WriteString(h, filepath.ToSlash(rel)+"\x00")
	var n int64
	if data != nil {
		var w int
		w, err = out.Write(data)
		h.Write(data)
		n = int64(w)
	} else {
		var in *os.File
		in, err = os.Open(src)
		if err == nil {
			n, err = io.Copy(io.MultiWriter(out, h), io.LimitReader(in, planned))
			in.Close()
		}
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return n, err
}

func sanitizedSvg(src string, size int64) ([]byte, error) {
	data := []byte(readLimited(src, size+1))
	return molten.SanitizeSvg(data)
}

type commitOpts struct {
	recopy    bool
	toolTitle bool
	version   int
}

// fits tells whether a copy of size bytes keeps the drawer and the whole registry under their caps.
func (s *Store) fits(key string, size int64, limits Limits) bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.fitsLocked(key, size, limits)
}

func (s *Store) fitsLocked(key string, size int64, limits Limits) bool {
	d, err := s.loadLocked(key)
	if err != nil {
		return false
	}
	return d.usage+size <= limits.ProjectCap && s.totalLocked()+size <= limits.TotalCap
}

// match finds the material a sighting is of: the same page id, address, or original file.
func (s *Store) match(key string, artifactId string, link string, original string) (molten.Material, bool) {
	s.lock.Lock()
	defer s.lock.Unlock()
	d, err := s.loadLocked(key)
	if err != nil {
		return molten.Material{}, false
	}
	for _, try := range []func(m molten.Material) bool{
		func(m molten.Material) bool { return artifactId != "" && m.ArtifactId == artifactId },
		func(m molten.Material) bool { return link != "" && m.Link == link },
		func(m molten.Material) bool { return original != "" && m.Original == original },
	} {
		for _, m := range d.index.Materials {
			if try(m) {
				return m, true
			}
		}
	}
	return molten.Material{}, false
}

// commit writes a sighting into the drawer: the new material, or what changes of the known one, with its new version
// renamed into place before the index names it.
func (s *Store) commit(key string, folder string, existingId string, rec molten.Material, ver *pendingVersion, opts commitOpts, limits Limits) (molten.Material, bool, error) {
	s.lock.Lock()
	d, err := s.loadLocked(key)
	if err != nil {
		s.lock.Unlock()
		if ver != nil {
			os.RemoveAll(ver.tmp)
		}
		return molten.Material{}, false, err
	}
	now := s.now().UnixMilli()
	i := -1
	if existingId != "" {
		i = findLocked(d, existingId)
	}
	if ver != nil && !s.fitsLocked(key, ver.size, limits) {
		os.RemoveAll(ver.tmp)
		ver = nil
		rec.Copy = molten.MaterialCopySpaceFull
	}
	created := i < 0
	if created {
		if opts.recopy {
			s.lock.Unlock()
			if ver != nil {
				os.RemoveAll(ver.tmp)
			}
			return molten.Material{}, false, nil
		}
		rec.Id = newId(s.now())
		rec.Created, rec.Updated = now, now
		d.index.Materials = append(d.index.Materials, rec)
		i = len(d.index.Materials) - 1
	}
	m := &d.index.Materials[i]
	if ver != nil && len(m.Versions) > 0 && m.Versions[len(m.Versions)-1].Hash == ver.hash {
		os.RemoveAll(ver.tmp)
		ver = nil
	}
	changed := created
	if !created {
		changed = mergeSighting(m, rec, ver != nil, opts)
	}
	if m.Original != "" && s.dropWorkFileLocked(d, m.Original) {
		changed = true
	}
	var removeAfter []string
	var pruned []molten.MaterialVersion
	if ver != nil {
		item := filepath.Join(s.drawerDir(key), itemsDir, m.Id)
		if err := ensureDir(filepath.Join(s.drawerDir(key), itemsDir)); err == nil {
			err = ensureDir(item)
		}
		n := 1
		if len(m.Versions) > 0 {
			n = m.Versions[len(m.Versions)-1].N + 1
		}
		replace := opts.recopy && len(m.Versions) > 0
		if replace {
			n = m.Versions[len(m.Versions)-1].N
		} else if opts.version > n && opts.version <= n+maxVersionSkip {
			// The copy is of the page's version the tool numbered: the sources of the versions before it are gone.
			n = opts.version
		}
		name := fmt.Sprintf("v%d", n)
		if _, statErr := os.Lstat(filepath.Join(item, name)); statErr == nil || replace {
			name = fmt.Sprintf("v%d.%s", n, randomSuffix())
		}
		if err == nil {
			err = os.Rename(ver.tmp, filepath.Join(item, name))
		}
		if err != nil {
			os.RemoveAll(ver.tmp)
			if created {
				d.index.Materials = d.index.Materials[:len(d.index.Materials)-1]
			}
			s.lock.Unlock()
			return molten.Material{}, false, err
		}
		s.kill("commit:renamed")
		v := molten.MaterialVersion{N: n, At: now, Title: rec.Title, Size: ver.size, Files: ver.files, Dir: name, Main: ver.main, Hash: ver.hash}
		if replace {
			removeAfter = append(removeAfter, filepath.Join(item, m.Versions[len(m.Versions)-1].Dir))
			m.Versions[len(m.Versions)-1] = v
		} else {
			m.Versions = append(m.Versions, v)
			for len(m.Versions) > limits.MaxVersions && len(m.Versions) > 2 {
				pruned = append(pruned, m.Versions[1])
				m.Versions = append(m.Versions[:1:1], m.Versions[2:]...)
			}
		}
		m.Copy, m.Size, m.Files = molten.MaterialCopyKept, ver.size, ver.files
		if ver.thumb != nil && s.writeAtomic(filepath.Join(item, thumbFile), ver.thumb) == nil {
			m.Thumb = true
		}
		changed = true
	}
	if !changed {
		out := *m
		s.lock.Unlock()
		return s.view(out), false, nil
	}
	m.Updated = now
	out := *m
	if err := s.saveLocked(d, folder); err != nil {
		s.lock.Unlock()
		return molten.Material{}, false, err
	}
	s.kill("commit:indexed")
	for _, dir := range removeAfter {
		os.RemoveAll(dir)
	}
	for _, v := range pruned {
		s.trashVersionLocked(key, out.Id, v)
	}
	s.lock.Unlock()
	s.changed(key, out.Id)
	return s.view(out), true, nil
}

// mergeSighting brings what a new sighting says into a known material; it tells whether anything changed. The title
// follows a republication unless the developer renamed the material.
func mergeSighting(m *molten.Material, rec molten.Material, copied bool, opts commitOpts) bool {
	changed := false
	set := func(dst *string, v string) {
		if v != "" && *dst != v {
			*dst = v
			changed = true
		}
	}
	setIfEmpty := func(dst *string, v string) {
		if *dst == "" && v != "" {
			*dst = v
			changed = true
		}
	}
	setIfEmpty(&m.Link, rec.Link)
	set(&m.ArtifactId, rec.ArtifactId)
	if rec.Original != "" && m.Original != rec.Original {
		m.Original, m.OriginalName, m.MayBeLost = rec.Original, rec.OriginalName, rec.MayBeLost
		changed = true
	}
	if rec.Source == molten.MaterialSourcePublished && m.Source != rec.Source {
		m.Source = rec.Source
		changed = true
	}
	if m.Kind == molten.MaterialKindLink && rec.Kind != molten.MaterialKindLink {
		m.Kind = rec.Kind
		changed = true
	}
	if opts.toolTitle || (copied && m.Source != molten.MaterialSourcePublished) {
		if m.Renamed {
			set(&m.AutoTitle, rec.Title)
		} else {
			set(&m.Title, rec.Title)
		}
	}
	setIfEmpty(&m.SessionId, rec.SessionId)
	setIfEmpty(&m.Agent, rec.Agent)
	setIfEmpty(&m.Tool, rec.Tool)
	if m.Ticket == 0 && rec.Ticket != 0 {
		m.Ticket = rec.Ticket
		changed = true
	}
	if !copied && len(m.Versions) == 0 && rec.Copy != "" && m.Copy != rec.Copy {
		m.Copy, m.Size = rec.Copy, rec.Size
		changed = true
	}
	return changed
}
