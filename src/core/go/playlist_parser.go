package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Result holds the parsed duration for a file
type Result struct {
	Path     string  `json:"path"`
	Duration float64 `json:"duration"`
}

// CacheEntry holds the cached duration and last modification time
type CacheEntry struct {
	ModTime  time.Time
	Duration float64
}

var (
	cache      = make(map[string]CacheEntry)
	cacheMutex sync.RWMutex
)

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	var currentBatch []string

	// Infinite loop: read lines, build batch, process on sentinel
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		if line == "<<BATCH_END>>" {
			processBatch(currentBatch)
			currentBatch = nil // Reset for next batch
			continue
		}

		if line != "" {
			currentBatch = append(currentBatch, line)
		}
	}
}

func processBatch(paths []string) {
	if len(paths) == 0 {
		fmt.Println("{}")
		return
	}

	// 1. Worker Pool Setup
	numWorkers := runtime.NumCPU() * 2
	jobs := make(chan string, len(paths))
	results := make(chan Result, len(paths))
	var wg sync.WaitGroup

	// 2. Start Workers
	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go worker(jobs, results, &wg)
	}

	// 3. Send Jobs
	for _, p := range paths {
		jobs <- p
	}
	close(jobs)

	// 4. Wait for workers in a separate goroutine to close results channel
	go func() {
		wg.Wait()
		close(results)
	}()

	// 5. Collect Results into a Map
	output := make(map[string]float64)
	for res := range results {
		output[res.Path] = res.Duration
	}

	// 6. Print JSON (NewEncoder appends a newline, which is crucial for the Node.js readline)
	jsonEncoder := json.NewEncoder(os.Stdout)
	if err := jsonEncoder.Encode(output); err != nil {
		fmt.Fprintf(os.Stderr, "Error encoding JSON: %v\n", err)
	}
}

func worker(jobs <-chan string, results chan<- Result, wg *sync.WaitGroup) {
	defer wg.Done()

	for path := range jobs {
		// 1. Get File Info (for cache check)
		info, err := os.Stat(path)
		if err != nil {
			// File likely doesn't exist or permissions issue
			results <- Result{Path: path, Duration: 0}
			continue
		}

		// 2. Check Cache
		cacheMutex.RLock()
		entry, found := cache[path]
		cacheMutex.RUnlock()

		if found && entry.ModTime.Equal(info.ModTime()) {
			results <- Result{Path: path, Duration: entry.Duration}
			continue
		}

		// 3. Cache Miss - Parse File
		dur := parsePlaylist(path)

		// 4. Update Cache
		cacheMutex.Lock()
		cache[path] = CacheEntry{
			ModTime:  info.ModTime(),
			Duration: dur,
		}
		cacheMutex.Unlock()

		results <- Result{Path: path, Duration: dur}
	}
}

func parsePlaylist(fpath string) float64 {
	content, err := os.ReadFile(fpath)
	if err != nil {
		return 0
	}

	var duration float64
	prefix := []byte("#EXTINF:")

	r := bytes.NewReader(content)
	scanner := bufio.NewScanner(r)

	for scanner.Scan() {
		line := scanner.Bytes()
		if bytes.HasPrefix(line, prefix) {
			valBytes := line[len(prefix):]
			commaIdx := bytes.IndexByte(valBytes, ',')
			if commaIdx != -1 {
				valBytes = valBytes[:commaIdx]
			}
			val, err := strconv.ParseFloat(string(valBytes), 64)
			if err == nil {
				duration += val
			}
		}
	}

	return duration
}