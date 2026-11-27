// The worker's turns at the description model: the description lane and the upload's phrase
// rewrite each start the model for their job and stop it when it is done, so the model holds
// no memory between jobs. They take turns because the managed server has one port, and a job
// started while another's server is up would find that port occupied. Outside the worker
// (manual commands) each call simply starts and stops its own.
export class DescriptionModelTurns {
    private queue: Promise<unknown> = Promise.resolve();

    // Runs one job after the jobs before it.
    take<T>(job: () => Promise<T>): Promise<T> {
        const turn = this.queue.then(job);
        this.queue = turn.catch(() => undefined);
        return turn;
    }
}

let turns: DescriptionModelTurns | null = null;

// The worker's lanes share one queue; everything else runs its job directly.
export function shareDescriptionModel(): DescriptionModelTurns {
    turns ??= new DescriptionModelTurns();
    return turns;
}

export function sharedDescriptionModel(): DescriptionModelTurns | null {
    return turns;
}
