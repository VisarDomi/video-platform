import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseMessage, PING_INTERVAL_MS, readLines, UPLINK_PROTOCOL } from "./protocol.js";

type Message = Record<string, unknown> & { type: string };

// What the PC expects the runner to be: the commit the deploy script last delivered to the
// uplink's machine, recorded beside the ledger (uplink-runner.json).
export function deployedRunnerFile(databasePath: string): string {
    return path.join(path.dirname(databasePath), "uplink-runner.json");
}

export async function deployedRunnerCommit(databasePath: string): Promise<string> {
    const file = deployedRunnerFile(databasePath);
    let info: { commit?: unknown };
    try { info = JSON.parse(await readFile(file, "utf8")) as { commit?: unknown }; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`${file}: the uplink runner was never deployed; deploy it first`);
        }
        throw new Error(`${file}: not readable as JSON`);
    }
    if (typeof info.commit !== "string" || !info.commit) throw new Error(`${file}: names no commit`);
    return info.commit;
}

// One run of the runner command: it speaks first (hello, with its protocol and commit),
// then takes one command. The PC pings while it is open; closing it ends stdin, which
// stops the runner.
export class RunnerConnection {
    private readonly queue: Message[] = [];
    private waiting: ((message: Message | null) => void) | null = null;
    private ended = false;
    private stderrTail = "";
    private readonly ping: NodeJS.Timeout;
    private exit: string | null = null;

    private constructor(private readonly child: ChildProcessWithoutNullStreams) {
        readLines(child.stdout, (line) => {
            let message: Message;
            try { message = parseMessage(line); } catch { return; }
            this.push(message);
        }, () => this.push(null));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
            for (const line of chunk.split("\n").filter((entry) => entry.trim())) {
                console.error(`uplink-runner: ${line.slice(0, 1_000)}`);
            }
        });
        child.on("exit", (code, signal) => { this.exit = signal ? `signal ${signal}` : `exit ${code}`; this.push(null); });
        child.on("error", (error) => { this.exit = error.message; this.push(null); });
        child.stdin.on("error", () => undefined);
        this.ping = setInterval(() => this.send({ type: "ping" }), PING_INTERVAL_MS);
    }

    static async open(command: readonly string[], expectedCommit: string, signal?: AbortSignal, helloTimeoutMs = 90_000): Promise<RunnerConnection> {
        const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
        const connection = new RunnerConnection(child);
        const abort = () => connection.close();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => connection.close(), helloTimeoutMs);
        try {
            const hello = await connection.next();
            if (!hello) await connection.exited();
            if (!hello || hello.type !== "hello") {
                throw new Error(`uplink: the runner did not answer (${connection.describeEnd()})`);
            }
            if (hello.protocol !== UPLINK_PROTOCOL) {
                throw new Error(`uplink: the runner speaks protocol ${String(hello.protocol)}, this PC ${UPLINK_PROTOCOL}; deploy the runner again`);
            }
            if (hello.commit !== expectedCommit) {
                throw new Error(`uplink: the runner is commit ${String(hello.commit)}, the PC deployed ${expectedCommit}; deploy the runner again`);
            }
            return connection;
        } catch (error) {
            connection.close();
            throw error;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        }
    }

    private push(message: Message | null): void {
        if (message === null) this.ended = true;
        if (this.waiting) {
            const deliver = this.waiting;
            this.waiting = null;
            deliver(message ?? (this.queue.shift() ?? null));
            return;
        }
        if (message) this.queue.push(message);
    }

    // The next line from the runner, or null once it has ended.
    next(): Promise<Message | null> {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve(queued);
        if (this.ended) return Promise.resolve(null);
        return new Promise((resolve) => { this.waiting = resolve; });
    }

    send(message: Record<string, unknown>): void {
        if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    // Resolves once the runner process has exited (or after a short wait), so its exit
    // status can be told.
    exited(waitMs = 3_000): Promise<void> {
        if (this.exit !== null) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            this.child.once("exit", () => { clearTimeout(timer); setImmediate(resolve); });
        });
    }

    describeEnd(): string {
        const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
        return `${this.exit ?? "connection closed"}${tail ? `: ${tail.slice(-600)}` : ""}`;
    }

    close(): void {
        clearInterval(this.ping);
        this.child.stdin.end();
        if (this.child.exitCode === null && this.child.signalCode === null) {
            const kill = setTimeout(() => this.child.kill("SIGTERM"), 5_000);
            kill.unref();
            this.child.once("exit", () => clearTimeout(kill));
        }
    }

    // One command and its single answer (probe, release).
    static async ask(command: readonly string[], expectedCommit: string, message: Record<string, unknown>,
        expect: string, signal?: AbortSignal): Promise<Message> {
        const connection = await RunnerConnection.open(command, expectedCommit, signal);
        try {
            connection.send(message);
            const answer = await connection.next();
            if (answer?.type === expect) return answer;
            if (answer?.type === "error") {
                const error = answer.error as { message?: unknown } | undefined;
                throw new Error(`uplink: the runner failed: ${String(error?.message ?? "unknown error")}`);
            }
            throw new Error(`uplink: the runner gave no ${expect} answer (${connection.describeEnd()})`);
        } finally { connection.close(); }
    }
}
