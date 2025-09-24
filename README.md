# tango-downloader
Download from tango.

## how to use
1. on windows import the .xml to task scheduler or do it manually by creating a task in task scheduler with these parameters:

create basic task -> when I log on -> start a program ->
Program/script:
C:\Windows\System32\wscript.exe 

Add arguments (optional): D:\media\livestreams\tango-dl\Tango.vbs
Start in (optional): D:\media\livestreams\tango-dl\

2. add streamers to streamers.txt

## dev
### notes
we got a working auth:
Tango-ST is 1h access token
Tango-RT is 90 days refresh token

we get Tango-RT from intercepting /login response
we refresh Tango-RT and Tango-ST using the /refresh response - tango has a wrong logic here and gives us a new refresh token, making it possible to go into a refresh loop. we just need to save this refresh token in a file so that any lights out does not trigger a login next time, only if we were offline for 90 days straight.

second note: tango has another logic error, where if streams have been ended by tango, so that if you refresh or go back to /following, the streams will not show. but if you continue to watch them, even if they don't show on /following (using another device for example), you can still watch them.

this means, we can download hidden streams.

### far TODO
automate exploration:
1. get /following (works) and /recommended (todo)
2. permanent download /following (works) temp download /recommended (todo)
3. saturate 500mbps, a stream is 2336 kb/s, which means 250 streams at once, if nvme is hit too hard, should have some pipe or something
3. compare the difference between calling /masterlistUrl and /liveUrl
4. make a simple csv with the results:
streamerId, streamerName, masterlistUrl, liveUrl, masterTime, liveTime, liveTime/masterTime ratio

note: it seems like tango has fixed the ui, but not the backend. but the ui will be enough to make streamers end the stream prematurely compared to non-fixed UI

### near TODO
see if the modded .mp4 files work on safari ios

1. make a bunch of conversions
2. point the dashboard to this folder
3. test


    ffmpeg \
        -nostdin \
        -hide_banner \
        -loglevel error \
        -stats \
        -f concat \
        -safe 0 \
        -i "$FILE_LIST" \
        -c copy \
        -bsf:a aac_adtstoasc \
        -movflags +faststart \
        -fflags +genpts \
        -y \
        "$OUTPUT_FILE"

TODO: test if the app works at all