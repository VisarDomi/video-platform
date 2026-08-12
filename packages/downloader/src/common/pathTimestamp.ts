interface DateParts {
    year: number;
    month: number;
    day: number;
    hours: number;
    minutes: number;
    seconds: number;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function parts(date: Date, utc: boolean): DateParts {
    return utc
        ? {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hours: date.getUTCHours(),
            minutes: date.getUTCMinutes(),
            seconds: date.getUTCSeconds(),
        }
        : {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hours: date.getHours(),
            minutes: date.getMinutes(),
            seconds: date.getSeconds(),
        };
}

export function formatTimestampForPath(date: Date, utc = false): string {
    if (!Number.isFinite(date.getTime())) throw new Error("Cannot format an invalid timestamp");
    const value = parts(date, utc);
    const datePart = `${value.year}-${pad(value.month)}-${pad(value.day)}`;
    const timePart = `${pad(value.hours)}${pad(value.minutes)}${pad(value.seconds)}`;
    return utc ? `${datePart}T${timePart}Z` : `${datePart} ${timePart}`;
}
