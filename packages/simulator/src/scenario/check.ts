// The scenario validator's building blocks: small strict checkers that
// collect every problem with its path instead of stopping at the first.

export type Check<T> = (value: unknown, path: string, problems: string[]) => T | undefined;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function str(pattern?: RegExp, what = "a string"): Check<string> {
    return (v, path, problems) => {
        if (typeof v !== "string" || v.length === 0) { problems.push(`${path}: expected ${what}`); return undefined; }
        if (pattern && !pattern.test(v)) { problems.push(`${path}: "${v}" is not ${what}`); return undefined; }
        return v;
    };
}

export function num(min: number, max = Infinity, integer = false): Check<number> {
    return (v, path, problems) => {
        if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
            problems.push(`${path}: expected ${integer ? "an integer" : "a number"} in [${min}, ${max}]`);
            return undefined;
        }
        return v;
    };
}

export const bool: Check<boolean> = (v, path, problems) => {
    if (typeof v !== "boolean") { problems.push(`${path}: expected true or false`); return undefined; }
    return v;
};

export function oneOf<T extends string | number>(...values: T[]): Check<T> {
    return (v, path, problems) => {
        if (!values.includes(v as T)) { problems.push(`${path}: expected one of ${values.map(x => JSON.stringify(x)).join(", ")}`); return undefined; }
        return v as T;
    };
}

export function parseSeconds(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v !== "string") return undefined;
    const m = /^\s*(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?\s*$/.exec(v);
    if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export const seconds: Check<number> = (v, path, problems) => {
    const s = parseSeconds(v);
    if (s === undefined) problems.push(`${path}: expected seconds (a number, or a string like "90s", "15m", "1h30m")`);
    return s;
};

export function list<T>(item: Check<T>): Check<T[]> {
    return (v, path, problems) => {
        if (!Array.isArray(v)) { problems.push(`${path}: expected an array`); return undefined; }
        const out: T[] = [];
        v.forEach((x, i) => { const r = item(x, `${path}[${i}]`, problems); if (r !== undefined) out.push(r); });
        return out;
    };
}

export type Fields = Record<string, { check: Check<any>; optional?: boolean; default?: unknown }>;
export const req = (check: Check<any>) => ({ check });
export const opt = (check: Check<any>, def?: unknown) => ({ check, optional: true, default: def });

export function object(fields: Fields): Check<Record<string, any>> {
    return (v, path, problems) => {
        if (!isObject(v)) { problems.push(`${path}: expected an object`); return undefined; }
        const out: Record<string, any> = {};
        for (const key of Object.keys(v)) {
            if (!(key in fields)) problems.push(`${path}: unknown key "${key}"`);
        }
        for (const [key, spec] of Object.entries(fields)) {
            if (v[key] === undefined) {
                if (!spec.optional) problems.push(`${path}: missing "${key}"`);
                else if (spec.default !== undefined) out[key] = spec.default;
                continue;
            }
            const r = spec.check(v[key], `${path}.${key}`, problems);
            if (r !== undefined) out[key] = r;
        }
        return out;
    };
}

/** A tagged union member: `{type, ...fields}`, with `type` limited to `allowed`. */
export function tagged(shapes: Record<string, Fields>, allowed: string[], what: string): Check<any> {
    return (v, path, problems) => {
        if (!isObject(v) || typeof v.type !== "string") { problems.push(`${path}: expected a ${what} with a "type"`); return undefined; }
        if (!allowed.includes(v.type)) {
            problems.push(`${path}: ${what} type "${v.type}" is not one of ${allowed.join(", ")}`);
            return undefined;
        }
        const { type, ...rest } = v;
        const out = object(shapes[type])(rest, path, problems);
        if (out && "until" in out && "at" in out && out.until <= out.at) problems.push(`${path}: "until" must be after "at"`);
        return out ? { type, ...out } : undefined;
    };
}
