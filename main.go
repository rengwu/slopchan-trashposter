package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"trashposter/internal/engine"
)

//go:embed all:frontend/dist
var assets embed.FS

type App struct {
	engine *engine.Engine
	ctx    context.Context
}

func (a *App) State() engine.State { return a.engine.State() }
func (a *App) Save(config json.RawMessage) (engine.State, error) {
	if err := a.engine.Save(config); err != nil {
		return engine.State{}, err
	}
	return a.engine.State(), nil
}
func (a *App) Start() error               { return a.engine.Start() }
func (a *App) Stop()                      { a.engine.Stop() }
func (a *App) Launch() error              { return a.engine.Launch() }
func (a *App) TestBoard() (string, error) { return a.engine.TestBoard() }
func (a *App) OpenPost(id string) error {
	for _, r := range a.engine.State().Runs {
		if r.ID == id && r.PostURL != "" {
			runtime.BrowserOpenURL(a.ctx, r.PostURL)
			return nil
		}
	}
	return fmt.Errorf("No published post for this session.")
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "--board-reader" {
		if len(os.Args) != 3 {
			fmt.Fprintln(os.Stderr, "Usage: trashposter --board-reader URL")
			os.Exit(1)
		}
		if err := engine.ServeReader(os.Args[2], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	// Finder-launched apps inherit a minimal PATH. Add common CLI installation directories.
	home, _ := os.UserHomeDir()
	existing := os.Getenv("PATH")
	for _, p := range []string{filepath.Join(home, ".local", "bin"), filepath.Join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"} {
		if !strings.Contains(string(os.PathListSeparator)+existing+string(os.PathListSeparator), string(os.PathListSeparator)+p+string(os.PathListSeparator)) {
			existing += string(os.PathListSeparator) + p
		}
	}
	_ = os.Setenv("PATH", existing)
	directory := os.Getenv("TRASHPOSTER_DATA_DIR")
	if directory == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			panic(err)
		}
		directory = filepath.Join(base, "Trashposter")
	}
	e, err := engine.New(directory)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer e.Close()
	app := &App{engine: e}
	err = wails.Run(&options.App{Title: "TRASHPOSTER", Width: 1440, Height: 1000, MinWidth: 1000, MinHeight: 700, BackgroundColour: options.NewRGB(24, 28, 32), AssetServer: &assetserver.Options{Assets: assets}, OnStartup: func(ctx context.Context) { app.ctx = ctx }, OnShutdown: func(context.Context) { e.Close() }, Bind: []interface{}{app}, Mac: &mac.Options{About: &mac.AboutInfo{Title: "TRASHPOSTER", Message: "Slopchan broadcasting workstation"}}})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
