type Listener<T> = (data: T) => void;

export class Emitter<T_Events extends Record<string, any>> {
    private events: { [K in keyof T_Events]?: Listener<T_Events[K]>[] } = {};

    public on<K extends keyof T_Events>(event: K, listener: Listener<T_Events[K]>): void {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event]!.push(listener);
    }

    public emit<K extends keyof T_Events>(...args: T_Events[K] extends void ? [K] : [K, T_Events[K]]): void {
        const [event, data] = args;
        if (this.events[event]) {
            this.events[event]!.forEach((listener) => listener(data as any));
        }
    }
}
