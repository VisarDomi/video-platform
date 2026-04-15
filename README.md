# What

This monorepo has a lot of moving parts that make it possible to download, view, edit livestreams from 3 providers.

# Why

The extension solutions either don't download correctly or are lower quality. Also this saves streams in the 1second .ts format that they come from the API, so that modifying the video is as simple as moving the right collection of .ts files instead of using ffmpeg with custom flags to try to retain as much information as possible. It's also minimal on cpu usage because there is no conversion or remuxing happenign.

# How

One provider I implemented myself, the other two are inspired by other github repos. This repo has gone through a lot of changes since the first provider. So it saves all the 1second .ts files of a stream in a folder. From the ui you can then either view it using apple's mpegts requirements, because safari apple is very strict on metadata and format of the stream. So the download and server try to keep the best playlist.m3u8 possible so that it's playable on safari ios. So discontinuities and changes of quality are present in the playlist in the appropriate place. This repo is also enhanced by other userscripts that control the provider .txt files so that you can add a streamer to watch for download directly from the target website, without needing to use a pc. The provider I implemented uses oauth, so i have a playwright backup to login automatically using google by using xvfb of linux to load the chrome headfull on memory, so that it bypasses the usual bot checks. This is not useful when scraping a lot, but it's useful for low impact actions you would usually do manually and rarely. The UI has swipe gestures to make navigation feel polished.

# provider manifest setup

The live provider manifest files are private and stay local:

- `packages/downloader/tango.txt`
- `packages/downloader/fc2.txt`
- `packages/downloader/sc.txt`

To set them up:

1. Copy each example file and remove the `.example` suffix.
2. Put whatever private content you want in the live files.

Example:

- `packages/downloader/tango.txt.example` -> `packages/downloader/tango.txt`
- `packages/downloader/fc2.txt.example` -> `packages/downloader/fc2.txt`
- `packages/downloader/sc.txt.example` -> `packages/downloader/sc.txt`
