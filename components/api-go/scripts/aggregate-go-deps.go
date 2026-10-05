// @intent Merge internal/modules/*/go.mod.fragment require blocks into root go.mod
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/mod/modfile"
)

type goModFragment struct {
	Description string            `json:"description"`
	Require     map[string]string `json:"require"`
}

func main() {
	if err := aggregateGoDeps(); err != nil {
		fmt.Fprintf(os.Stderr, "aggregate-go-deps: %v\n", err)
		os.Exit(1)
	}
}

func aggregateGoDeps() error {
	root, err := componentRoot()
	if err != nil {
		return err
	}

	goModPath := filepath.Join(root, "go.mod")
	raw, err := os.ReadFile(goModPath)
	if err != nil {
		return fmt.Errorf("read go.mod: %w", err)
	}

	mf, err := modfile.Parse(goModPath, raw, nil)
	if err != nil {
		return fmt.Errorf("parse go.mod: %w", err)
	}

	fragments, err := collectFragments(filepath.Join(root, "internal", "modules"))
	if err != nil {
		return err
	}

	for _, frag := range fragments {
		label := frag.label
		for path, version := range frag.require {
			if strings.TrimSpace(path) == "" || strings.TrimSpace(version) == "" {
				continue
			}
			if err := upsertRequire(mf, path, version, label); err != nil {
				return err
			}
		}
	}

	formatted := modfile.Format(mf.Syntax)
	if err := os.WriteFile(goModPath, formatted, 0o644); err != nil {
		return fmt.Errorf("write go.mod: %w", err)
	}

	fmt.Printf(
		"Merged Go dependencies from %d go.mod.fragment file(s) into go.mod\n",
		len(fragments),
	)
	return nil
}

type collectedFragment struct {
	label   string
	require map[string]string
}

func collectFragments(modulesDir string) ([]collectedFragment, error) {
	entries, err := os.ReadDir(modulesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read modules dir: %w", err)
	}

	var fragments []collectedFragment
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		fragmentPath := filepath.Join(modulesDir, entry.Name(), "go.mod.fragment")
		if _, err := os.Stat(fragmentPath); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("stat %s: %w", fragmentPath, err)
		}

		raw, err := os.ReadFile(fragmentPath)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", fragmentPath, err)
		}

		var doc goModFragment
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("parse %s: %w", fragmentPath, err)
		}
		if doc.Require == nil {
			doc.Require = map[string]string{}
		}

		fragments = append(fragments, collectedFragment{
			label:   fragmentPath,
			require: doc.Require,
		})
	}

	sort.Slice(fragments, func(i, j int) bool {
		return fragments[i].label < fragments[j].label
	})
	return fragments, nil
}

func upsertRequire(mf *modfile.File, path, version, source string) error {
	for _, req := range mf.Require {
		if req.Mod.Path != path {
			continue
		}
		if req.Mod.Version == version {
			return nil
		}
		if err := mf.DropRequire(path); err != nil {
			return fmt.Errorf("drop require %s before merge from %s: %w", path, source, err)
		}
		break
	}

	if err := mf.AddRequire(path, version); err != nil {
		return fmt.Errorf("add require %s from %s: %w", path, source, err)
	}
	return nil
}

func componentRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "internal", "modules")); err == nil {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("could not find api-go component root from %s", wd)
}

