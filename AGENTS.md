# Video platform

Agent owns repo/recordings; user deletion of originals is normal. Read README.md,
notes.md, decisions.md and affected package docs; iOS: apps/ios/README.md,
../../ios-tools/native/README.md; access: ../../../environment/mac-access.md.

- Phone explores; PC backs up. Phone renewal survives expiry/background/network
  changes independently; PC/phone have separate rotating token families, one owner
  each. Initial setup/API migration may use the PC helper once.
- Routine PC browser/auth runs headful on Xvfb :111 under existing profile ownership.
  Never use the desktop, kill another owner, delete its lock or copy an active profile.
- Porntrex repair is preauthorized: reuse valid shared/phone sessions; only if all
  are rejected use `ptrex-connect-iphone --apply --allow-password-login` once,
  share with Video Vault and verify both. No independent phone login or kt_member.
  Outages/delivery failures do not justify another login; retry phone delivery.
  Session maintenance continues during upload/gaming holds; never resume the worker.
- Test, then `ios-push APP`; read ../../ios-tools/push/README.md. Captured/queued is
  not installed: check `ios-push status JOB`. Preserve frozen approved renewal roots;
  mutable mirrors are not approval. Routine UI QA uses the Mac virtual iPhone;
  Infuse/Bunkr fluidity is owner-tested, phone installation only.
- Continuous scrolling/pinch follows the user. Loading, refresh, reuse and chapter
  append preserve position while scrolling; no snapping, centering, runways or
  settled-page gates. Explicit navigation/restoration are separate.
- At rest/zoom show only current video; neighbours appear during unzoomed vertical
  scrolling. VOD neighbours pause; Tango live neighbours play muted. Zoom disables
  carousel navigation; visibility never initiates snapping.
- Bunkr serves original bytes: no transcoding or playback copies. Keep overrides
  selected only in apps/ios/Bunkr. Preserve other providers' shipped engine and
  shared HLS playlists/segments byte-for-byte; report native codec limits.
- Codec diagnostic: stable identity/container/Local Network permission within a
  session; stop after each run. Finally uninstall and verify app/process absence:
  apps/ios/scripts/check-original-video.py --cleanup --device <UDID> --out <private-dir>.
- Diagnose source/history, installed artifacts and backend before asking the owner.
  Restore the full causal path, preserving unrelated fixes; verify other providers.
- Missing originals retain catalogue, remote IDs, upload/removal receipts and
  re-upload bans. Conversion cleanup is separate; download lists live outside Git.
- Children inherit provider/data/device/hold limits, ownership, tests and delivery
  proof. Inspect partial effects before retrying; preflight refusal is not Swift failure.
