# iOS debugger certificate trust

The repository-local debugger uses HTTPS. The iPhone must trust the development
machine's mkcert root CA before its userscript can communicate with the bridge.
This is a one-time process per development machine and CA.

The debugger userscript currently connects to `192.168.1.197:36666`;
certificate setup does not rewrite it. After cloning on another machine, first
update the address and port described in [`test.md`](test.md).

### 1. Install mkcert

Install [mkcert](https://github.com/FiloSottile/mkcert). On Linux, its local
trust-store integration may also require the `libnss3-tools` package.

### 2. Generate the repository-local certificates

From this repository:

```bash
npm run tests:setup
npm run tests:server
```

`tests:setup`:

- creates or installs the machine's mkcert CA if necessary;
- discovers the laptop's current LAN address, unless `IOS_DEBUG_HOST` is set;
- generates a leaf certificate covering that address, `localhost`, and
  `127.0.0.1`;
- stores the leaf certificate, private key, and a copy of the **public** root
  certificate under the gitignored `.ios-debug/` directory;
- prints the iPhone certificate and debugger URLs.

Keep `npm run tests:server` running while completing the phone steps.

### 3. Install the root CA on iPhone

1. Connect the iPhone and development machine to the same LAN.
2. Open `https://192.168.1.197:36666/api/cert`, or the corresponding URL
   configured for the cloned setup, in iPhone Safari.
3. On the first visit, Safari may warn that the server is not trusted yet.
   Proceed to the site once so the public CA profile can download.
4. Tap **Allow** when prompted to download the configuration profile.
5. Open **Settings → General → VPN & Device Management**.
6. Select the downloaded mkcert profile and tap **Install**.
7. Open **Settings → General → About → Certificate Trust Settings**.
8. Enable full trust for the mkcert root CA and confirm.

Installing the profile alone is not sufficient; full trust in step 8 is
required.

### When setup must be repeated

Repeat certificate generation and phone installation when:

- testing from a different development machine;
- the mkcert CA was deleted or regenerated;
- the generated leaf certificate expired;
- the laptop's LAN address changed and is not covered by the current
  certificate.

If only the LAN address changed, update the debugger userscript as described in
`test.md`, rerun `npm run tests:setup`, restart the server, and reinstall the
debugger userscript.

### Security

Do not copy or commit `.ios-debug/key.pem` or mkcert's `rootCA-key.pem`.
The `.ios-debug/` directory is ignored by Git. The `/api/cert` endpoint exposes
only the public root certificate. Remote command submission is accepted only
from loopback on the development machine.

