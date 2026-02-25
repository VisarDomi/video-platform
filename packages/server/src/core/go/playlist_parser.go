package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Job holds the processing task info
type Job struct {
	Index int
	Path  string
}

// Result holds the parsed duration and its original index
type Result struct {
	Index    int
	Duration float64
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
	// Buffer size increased to handle large inputs if necessary
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	var currentBatch []string

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		if line == "<<BATCH_END>>" {
			processBatch(currentBatch)
			currentBatch = nil
			continue
		}

		if line != "" {
			currentBatch = append(currentBatch, line)
		}
	}
}

func processBatch(paths []string) {
	count := len(paths)
	if count == 0 {
		fmt.Println("")
		return
	}

	// Pre-allocate storage for ordered results
	finalDurations := make([]float64, count)

	numWorkers := runtime.NumCPU() * 2

	jobs := make(chan Job, count)
	results := make(chan Result, count)
	var wg sync.WaitGroup

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go worker(jobs, results, &wg)
	}

	for i, p := range paths {
		jobs <- Job{Index: i, Path: p}
	}
	close(jobs)

	go func() {
		wg.Wait()
		close(results)
	}()

	// Collect results and place them in the correct index
	for res := range results {
		finalDurations[res.Index] = res.Duration
	}

	// Efficiently build the output string
	var sb strings.Builder
	// Pre-allocate approximation: 6 chars per float * count
	sb.Grow(count * 6)

	for i, dur := range finalDurations {
		if i > 0 {
			sb.WriteByte(';')
		}
		// Format float to suppress scientific notation, minimal decimals
		sb.WriteString(strconv.FormatFloat(dur, 'f', -1, 64))
	}

	// Print single line to stdout
	fmt.Println(sb.String())
}

func worker(jobs <-chan Job, results chan<- Result, wg *sync.WaitGroup) {
	defer wg.Done()

	for job := range jobs {
		path := job.Path

		info, err := os.Stat(path)
		if err != nil {
			results <- Result{Index: job.Index, Duration: 0}
			continue
		}

		cacheMutex.RLock()
		entry, found := cache[path]
		cacheMutex.RUnlock()

		if found && entry.ModTime.Equal(info.ModTime()) {
			results <- Result{Index: job.Index, Duration: entry.Duration}
			continue
		}

		dur := parsePlaylist(path)

		cacheMutex.Lock()
		cache[path] = CacheEntry{
			ModTime:  info.ModTime(),
			Duration: dur,
		}
		cacheMutex.Unlock()

		results <- Result{Index: job.Index, Duration: dur}
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