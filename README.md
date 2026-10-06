# What

A full video pipeline that saves the list of streamers to download, downloads their streams (local backup), views the downloads, edits the downloads, converts the edited videos, describes them, uploads them (online backup)

# Why

This project started out as a simple downloader, then it crept on scope until a full pipeline was developed. 

# How

One provider I implemented myself, the other two are inspired by other github repos. This repo has gone through a lot of changes since the first provider. So it saves all the 1second .ts files of a stream in a folder. From the ui you can then either view it using apple's mpegts requirements, because safari apple is very strict on metadata and format of the stream. So the download and server try to keep the best playlist.m3u8 possible so that it's playable on safari ios. So discontinuities and changes of quality are present in the playlist in the appropriate place. This repo is also enhanced by other userscripts that control the provider .txt files so that you can add a streamer to watch for download directly from the target website, without needing to use a pc. The provider I implemented uses google oauth, so i have a playwright backup to login automatically using google by using xvfb of linux to load the chrome headful on memory, so that it bypasses the usual bot checks. This is not useful when scraping a lot, but it's useful for low impact actions you would usually do manually and rarely. The UI has swipe gestures to make navigation feel polished.

# setup
[setup notes](./notes.md)
