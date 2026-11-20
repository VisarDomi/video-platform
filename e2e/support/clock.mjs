// Preloaded into every pipeline process the e2e starts (node --import): the process's
// clock starts at the run's simulated time ($E2E_NOW, epoch milliseconds) and runs on in
// real time, so the pipeline's day-long waits (verification a day after submission) pass
// between two commands. The simulator's manual clock is set to the same time.
const start = Number(process.env.E2E_NOW);
if (!Number.isFinite(start)) throw new Error("e2e clock: E2E_NOW is not set");
const RealDate = Date;
const offset = start - RealDate.now();
class ShiftedDate extends RealDate {
    constructor(...args) {
        if (args.length === 0) super(RealDate.now() + offset);
        else super(...args);
    }
    static now() { return RealDate.now() + offset; }
}
globalThis.Date = ShiftedDate;
