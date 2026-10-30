// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

// Materials (FR-MAT-001, DS-MAT-001): what agents produce for the developer outside the repository, kept per project
// by wavesrv in MoltenTerm's data folder (pkg/molten/materials). The windows and `molten material` reach the registry
// through a leaf of wavesrv's router; these names are shared with wsh and the library (#1426).

// must match frontend/moltenterm-shell/library/materials-model.ts (#1426)
const (
	MaterialsRoute = "molten:materials"
	// MaterialsEvent is published, scoped to the drawer's key, after each change of a drawer.
	MaterialsEvent = "molten:materials"

	MaterialsListCommand      = "moltenmaterialslist"
	MaterialGetCommand        = "moltenmaterialget"
	MaterialAddCommand        = "moltenmaterialadd"
	MaterialRenameCommand     = "moltenmaterialrename"
	MaterialPinCommand        = "moltenmaterialpin"
	MaterialDeleteCopyCommand = "moltenmaterialdeletecopy"
	MaterialRestoreCommand    = "moltenmaterialrestore"
	MaterialCopyCommand       = "moltenmaterialcopy"
	MaterialWorkFilesCommand  = "moltenmaterialworkfiles"
	// MaterialsRecoverCommand: "Search past sessions" (FR-MAT-008), from a window only.
	MaterialsRecoverCommand = "moltenmaterialsrecover"

	// The drawer of the workspaces without a project ("No project").
	MaterialsNoProject = "noproject"

	MaterialKindPage     = "page"
	MaterialKindLink     = "link"
	MaterialKindPdf      = "pdf"
	MaterialKindImage    = "image"
	MaterialKindVideo    = "video"
	MaterialKindText     = "text"
	MaterialKindDocument = "document"

	// Where a material came from: published to the cloud (signal 1), named in an answer (2, 3), declared with
	// `molten material add` (5), brought by the developer (6, FR-MAT-003).
	MaterialSourcePublished = "published"
	MaterialSourceNamed     = "named"
	MaterialSourceDeclared  = "declared"
	MaterialSourceBrought   = "brought"

	// The state of a material's copy; "" for a link without a source.
	MaterialCopyKept      = "kept"
	MaterialCopyTooLarge  = "toolarge"
	MaterialCopySpaceFull = "spacefull"
	MaterialCopySecret    = "secret"
	MaterialCopyMissing   = "missing"
	MaterialCopyFailed    = "failed"
)

// MaterialsRequest is the data of every materials command. A terminal names its own block; a window names a workspace,
// or a drawer by its key. Id names a material, TrashId a deleted copy (Undo). Target: the path or address to add, Cwd
// the folder a relative path is read from. Requested: a copy the developer asked for (the higher limit). AllowSecret:
// "Keep anyway" on a material the secret detection held back.
type MaterialsRequest struct {
	BlockId     string `json:"blockid,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	Project     string `json:"project,omitempty"`
	All         bool   `json:"all,omitempty"`
	Id          string `json:"id,omitempty"`
	TrashId     string `json:"trashid,omitempty"`
	Title       string `json:"title,omitempty"`
	Pinned      bool   `json:"pinned,omitempty"`
	Target      string `json:"target,omitempty"`
	Cwd         string `json:"cwd,omitempty"`
	Requested   bool   `json:"requested,omitempty"`
	AllowSecret bool   `json:"allowsecret,omitempty"`
}

// MaterialVersion is one copy of a material; N counts from 1, the first is always kept.
type MaterialVersion struct {
	N     int    `json:"n"`
	At    int64  `json:"at"`
	Title string `json:"title,omitempty"`
	Size  int64  `json:"size"`
	// Files: the linked files copied with the main one.
	Files int `json:"files,omitempty"`
	// Dir: the version's folder under items/<id>/; Main: the main file's name inside it.
	Dir  string `json:"dir"`
	Main string `json:"main"`
	Hash string `json:"hash,omitempty"`
}

// Material is one entry of a drawer's index (AC16 of FR-MAT-001). Its forms: Link (the address, cleaned), the copy
// (Versions, Copy says why there is none) and Original (the file it was copied from).
type Material struct {
	Id      string `json:"id"`
	Project string `json:"project"`
	Title   string `json:"title"`
	// AutoTitle: the title MoltenTerm found, kept when the developer renamed the material.
	AutoTitle    string `json:"autotitle,omitempty"`
	Renamed      bool   `json:"renamed,omitempty"`
	OriginalName string `json:"originalname,omitempty"`
	Kind         string `json:"kind"`
	Source       string `json:"source"`
	Link         string `json:"link,omitempty"`
	ArtifactId   string `json:"artifactid,omitempty"`
	Original     string `json:"original,omitempty"`
	// OriginalGone: the original file no longer exists (read when listed).
	OriginalGone bool `json:"originalgone,omitempty"`
	// MayBeLost: the original is under a temporary folder or an agent worktree.
	MayBeLost bool   `json:"maybelost,omitempty"`
	Copy      string `json:"copy,omitempty"`
	// CopyPath: the current version's main file, absolute (filled when listed).
	CopyPath string            `json:"copypath,omitempty"`
	Size     int64             `json:"size,omitempty"`
	Files    int               `json:"files,omitempty"`
	Versions []MaterialVersion `json:"versions,omitempty"`
	Pinned   bool              `json:"pinned,omitempty"`
	Thumb    bool              `json:"thumb,omitempty"`
	// Agent: the agent's first name; Tool: its id (claude, codex), "" for the developer.
	Agent       string `json:"agent,omitempty"`
	Tool        string `json:"tool,omitempty"`
	SessionId   string `json:"sessionid,omitempty"`
	Subject     string `json:"subject,omitempty"`
	Ticket      int    `json:"ticket,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	BlockId     string `json:"blockid,omitempty"`
	Created     int64  `json:"created"`
	Updated     int64  `json:"updated"`
}

// MaterialWorkFile is a file an agent wrote outside the repository without showing it: listed, never copied by itself.
type MaterialWorkFile struct {
	Path      string `json:"path"`
	At        int64  `json:"at"`
	Kind      string `json:"kind"`
	Size      int64  `json:"size,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Tool      string `json:"tool,omitempty"`
	SessionId string `json:"sessionid,omitempty"`
	Ticket    int    `json:"ticket,omitempty"`
	MayBeLost bool   `json:"maybelost,omitempty"`
}

// MaterialsProject names a drawer: its key, the project's folder ("" for No project) and its name.
type MaterialsProject struct {
	Key    string `json:"key"`
	Folder string `json:"folder,omitempty"`
	Name   string `json:"name,omitempty"`
}

// MaterialsUsage is what the copies take, against the caps; Full: a new copy would not fit.
type MaterialsUsage struct {
	Project    int64 `json:"project"`
	ProjectCap int64 `json:"projectcap"`
	Total      int64 `json:"total"`
	TotalCap   int64 `json:"totalcap"`
	Full       bool  `json:"full,omitempty"`
}

// MaterialsView is a list's answer: one drawer's materials, newest first (pinned ones first), and with All the other
// drawers' too.
type MaterialsView struct {
	Project   MaterialsProject   `json:"project"`
	Materials []Material         `json:"materials"`
	WorkFiles int                `json:"workfiles"`
	Usage     MaterialsUsage     `json:"usage"`
	Projects  []MaterialsProject `json:"projects,omitempty"`
}

// MaterialDeleted is a delete's answer: the trash entry Undo restores.
type MaterialDeleted struct {
	TrashId string `json:"trashid"`
}

// MaterialsRecovered is a past-session search's answer (FR-MAT-008): the transcripts read, the materials found in
// them (New of them were not in the registry), how many have a copy (Kept), how many sources were already erased
// (Gone: kept as links) and how many could not be copied for another reason (NotCopied: too large, a possible
// secret, space full).
type MaterialsRecovered struct {
	Sessions  int `json:"sessions"`
	Found     int `json:"found"`
	New       int `json:"new"`
	Kept      int `json:"kept"`
	Gone      int `json:"gone"`
	NotCopied int `json:"notcopied"`
}

// MaterialsChanged is the event's data.
type MaterialsChanged struct {
	Project string   `json:"project"`
	Ids     []string `json:"ids,omitempty"`
}

// MaterialForm says in one word what a material holds, for `molten material list`.
func MaterialForm(m Material) string {
	copied := m.Copy == MaterialCopyKept && len(m.Versions) > 0
	switch {
	case copied && m.Link != "":
		return "copy+link"
	case copied:
		return "copy"
	case m.Link != "" && m.Original == "":
		return "link"
	case m.Link != "":
		return "link+original"
	}
	return "original"
}
