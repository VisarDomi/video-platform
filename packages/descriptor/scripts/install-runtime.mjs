#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    activateRuntime,
    capture,
    dirtyFingerprint,
    readLock,
    run,
    runtimeRoot,
} from "./runtime-common.mjs";

function parseArguments(argv) {
    const result = {
        activate: true,
        source: null,
        buildDirectory: null,
        jobs: os.availableParallelism(),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--no-activate") result.activate = false;
        else if (argument === "--source") result.source = argv[++index];
        else if (argument === "--build-directory") result.buildDirectory = argv[++index];
        else if (argument === "--jobs") {
            const jobs = Number(argv[++index]);
            if (!Number.isSafeInteger(jobs) || jobs < 1) {
                throw new Error("--jobs must be a positive integer");
            }
            result.jobs = jobs;
        }
        else throw new Error(`Unknown argument: ${argument}`);
    }
    return result;
}

async function prepareRemoteSource(lock) {
    if (!/^[0-9a-f]{40}$/.test(lock.commit ?? "")) {
        throw new Error(
            "The runtime lock has no reviewed commit. Use --source for a local test build, then set the lock after committing and pushing the fork branch.",
        );
    }

    const cacheRoot = process.env.VIDEO_SERVICES_CACHE_ROOT
        ?? path.join(os.homedir(), ".cache", "video-services");
    const mirror = path.join(cacheRoot, "sources", "llama.cpp.git");
    const checkout = path.join(cacheRoot, "checkouts", `llama.cpp-${lock.commit}`);
    await fs.mkdir(path.dirname(mirror), { recursive: true });
    await fs.mkdir(path.dirname(checkout), { recursive: true });

    try {
        await fs.access(path.join(mirror, "HEAD"));
    } catch {
        run("git", ["init", "--bare", mirror]);
    }

    const remotes = capture("git", ["remote"], { cwd: mirror }).split("\n").filter(Boolean);
    if (remotes.includes("origin")) {
        run("git", ["remote", "set-url", "origin", lock.repository], { cwd: mirror });
    } else {
        run("git", ["remote", "add", "origin", lock.repository], { cwd: mirror });
    }
    run("git", [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${lock.branch}:refs/remotes/origin/${lock.branch}`,
    ], { cwd: mirror });
    run("git", ["merge-base", "--is-ancestor", lock.commit, `refs/remotes/origin/${lock.branch}`], { cwd: mirror });

    try {
        await fs.access(path.join(checkout, ".git"));
    } catch {
        run("git", ["clone", "--shared", "--no-checkout", mirror, checkout]);
    }
    run("git", ["checkout", "--detach", lock.commit], { cwd: checkout });
    return { sourceDirectory: checkout, commit: lock.commit, dirty: false };
}

async function prepareLocalSource(source) {
    const sourceDirectory = path.resolve(source);
    const commit = capture("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory });
    const status = capture("git", ["status", "--porcelain"], { cwd: sourceDirectory });
    return { sourceDirectory, commit, dirty: status.length > 0 };
}

async function copyRuntime(buildDirectory, targetDirectory, manifest) {
    const binaryDirectory = path.join(targetDirectory, "libexec");
    const libraryDirectory = path.join(targetDirectory, "lib");
    const launcherDirectory = path.join(targetDirectory, "bin");
    await Promise.all([
        fs.mkdir(binaryDirectory, { recursive: true }),
        fs.mkdir(libraryDirectory, { recursive: true }),
        fs.mkdir(launcherDirectory, { recursive: true }),
    ]);

    await fs.copyFile(
        path.join(buildDirectory, "bin", "llama-server"),
        path.join(binaryDirectory, "llama-server"),
    );
    const buildFiles = await fs.readdir(path.join(buildDirectory, "bin"));
    const libraries = buildFiles.filter((name) => /^lib.*\.so(?:\..*)?$/.test(name));
    if (libraries.length === 0) {
        throw new Error(`No llama.cpp shared libraries found in ${path.join(buildDirectory, "bin")}`);
    }
    await Promise.all(libraries.map((name) => fs.copyFile(
        path.join(buildDirectory, "bin", name),
        path.join(libraryDirectory, name),
    )));

    const launcher = `#!/usr/bin/env bash\nset -euo pipefail\nruntime_dir="$(cd "$(dirname "${"$"}{BASH_SOURCE[0]}")/.." && pwd)"\nexport LD_LIBRARY_PATH="${"$"}runtime_dir/lib${"$"}{LD_LIBRARY_PATH:+:${"$"}LD_LIBRARY_PATH}"\nexec "${"$"}runtime_dir/libexec/llama-server" "${"$"}@"\n`;
    const launcherPath = path.join(launcherDirectory, "llama-server");
    await fs.writeFile(launcherPath, launcher, { mode: 0o755 });
    await fs.writeFile(path.join(targetDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const options = parseArguments(process.argv.slice(2));
const lock = await readLock();
const source = options.source
    ? await prepareLocalSource(options.source)
    : await prepareRemoteSource(lock);
const fingerprint = source.dirty ? dirtyFingerprint(source.sourceDirectory) : null;
const runtimeId = `${source.commit.slice(0, 12)}${fingerprint ? `-dirty-${fingerprint}` : ""}`;
const buildDirectory = options.buildDirectory
    ? path.resolve(options.buildDirectory)
    : path.join(source.sourceDirectory, "build-video-platform");
const buildEnvironment = {
    ...process.env,
    CCACHE_BASEDIR: source.sourceDirectory,
};

run("cmake", ["-S", source.sourceDirectory, "-B", buildDirectory, ...lock.cmakeArgs], { env: buildEnvironment });
run("cmake", ["--build", buildDirectory, "--target", "llama-server", "--parallel", String(options.jobs)], { env: buildEnvironment });

await fs.mkdir(runtimeRoot, { recursive: true });
const targetDirectory = path.join(runtimeRoot, runtimeId);
try {
    await fs.access(targetDirectory);
    console.log(`Runtime already installed: ${targetDirectory}`);
} catch {
    const temporaryDirectory = path.join(runtimeRoot, `.${runtimeId}-${randomUUID()}`);
    await copyRuntime(buildDirectory, temporaryDirectory, {
        schemaVersion: 1,
        runtimeId,
        repository: lock.repository,
        branch: lock.branch,
        commit: source.commit,
        dirty: source.dirty,
        dirtyFingerprint: fingerprint,
        builtAt: new Date().toISOString(),
        cmakeArgs: lock.cmakeArgs,
    });
    await fs.rename(temporaryDirectory, targetDirectory);
    console.log(`Installed llama.cpp runtime: ${targetDirectory}`);
}

if (options.activate) {
    await activateRuntime(runtimeId);
    console.log(`Activated llama.cpp runtime: ${targetDirectory}`);
}
