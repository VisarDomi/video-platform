# Bunkr-only performance code

These source overrides and build settings are selected only for the `bunkr`
target. They retain its direct AV1/VP9 decoder, paused preparation, cancellation,
retirement and indexed local-library migration from the performance pass.
The other five targets cannot compile this directory or its decoder packages.

`VideoApp` retains the original shipped non-Bunkr engine (`b09884d`), including
its scroll/visibility, OK/Cut/Return and login/API fixes. Do not modify another
provider or shared HLS responses as a side effect of tuning Bunkr.

The common app registry and dispatchers select the target; they do not share
Bunkr's performance implementation. `test_provider_isolation.py` checks the
actual generated source lists and renewal inputs.
