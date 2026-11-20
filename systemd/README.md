# User services

The core's user units: the server, downloader, auth daemon, pipeline worker and its
dashboard, the Xvfb display and the processing slice that bounds conversion work. They
are templates (`{{HOME}}` is the user's home) installed into `~/.config/systemd/user` by

```sh
npm run systemd:check   # does the installed configuration match?
npm run systemd:sync    # install what differs, then daemon-reload (restarts nothing)
```

A deployment's own units (for example a destination's session upkeep) live in
`private/systemd/user` when the private plug-ins are checked out; the same commands
install them. Each unit is defined in one place only.
