package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// Result holds the parsed duration for a file
type Result struct {
	Path     string  `json:"path"`
	Duration float64 `json:"duration"`
}

func main() {
	// 1. Read all paths from STDIN
	var paths []string
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		p := strings.TrimSpace(scanner.Text())
		if p != "" {
			paths = append(paths, p)
		}
	}

	if len(paths) == 0 {
		fmt.Println("{}")
		return
	}

	// 2. Worker Pool Setup
	// Use roughly 2x CPU cores for IO-heavy tasks, or just GOMAXPROCS
	numWorkers := runtime.NumCPU() * 2
	jobs := make(chan string, len(paths))
	results := make(chan Result, len(paths))
	var wg sync.WaitGroup

	// 3. Start Workers
	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go worker(jobs, results, &wg)
	}

	// 4. Send Jobs
	for _, p := range paths {
		jobs <- p
	}
	close(jobs)

	// 5. Wait for workers in a separate goroutine to close results channel
	go func() {
		wg.Wait()
		close(results)
	}()

	// 6. Collect Results into a Map
	output := make(map[string]float64)
	for res := range results {
		output[res.Path] = res.Duration
	}

	// 7. Print JSON
	jsonEncoder := json.NewEncoder(os.Stdout)
	if err := jsonEncoder.Encode(output); err != nil {
		fmt.Fprintf(os.Stderr, "Error encoding JSON: %v\n", err)
		os.Exit(1)
	}
}

func worker(jobs <-chan string, results chan<- Result, wg *sync.WaitGroup) {
	defer wg.Done()

	// Pre-allocate a buffer for reading files to reduce allocation churn
	// 64KB is usually enough for m3u8 playlists
	// But since we use ReadFile (simple), we let Go handle it.
	// For max perf we could use a sync.Pool for buffers but ReadFile is simpler.

	for path := range jobs {
		dur := parsePlaylist(path)
		results <- Result{Path: path, Duration: dur}
	}
}

func parsePlaylist(fpath string) float64 {
	content, err := os.ReadFile(fpath)
	if err != nil {
		return 0
	}

	var duration float64

	// Convert byte slice to string usually causes alloc, but iterating bytes is faster
	// Let's iterate lines.
	// #EXTINF: is 8 chars.
	prefix := []byte("#EXTINF:")

	r := bytes.NewReader(content)
	scanner := bufio.NewScanner(r)

	for scanner.Scan() {
		line := scanner.Bytes()
		if bytes.HasPrefix(line, prefix) {
			// Line is #EXTINF:10.000,
			// We want "10.000"

			// Trim prefix
			valBytes := line[len(prefix):]

			// Find comma
			commaIdx := bytes.IndexByte(valBytes, ',')
			if commaIdx != -1 {
				valBytes = valBytes[:commaIdx]
			}

			// Parse float
			// unsafe string conversion is strictly faster but let's be safe
			val, err := strconv.ParseFloat(string(valBytes), 64)
			if err == nil {
				duration += val
			}
		}
	}

	return duration
}