export const DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES = 700_000_000_000;
export const REQUEST_OVERHEAD_RESERVATION_BYTES = 16 * 1024 * 1024;

function localCalendar(date: Date, timeZone: string): { month: string; day: number } {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if (!year || !month || !Number.isInteger(day) || day < 1 || day > 31) {
        throw new Error(`Could not derive upload calendar in ${timeZone}`);
    }
    return { month: `${year}-${month}`, day };
}

export function calendarMonth(date: Date, timeZone: string): string {
    return localCalendar(date, timeZone).month;
}

// Cumulative allowance, not three independent buckets: unused bytes stay
// available until the calendar month ends. An explicit lower cap still applies.
export function uploadBudget(
    date: Date,
    timeZone: string,
    monthlyLimitBytes = DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES,
) {
    if (!Number.isSafeInteger(monthlyLimitBytes) || monthlyLimitBytes <= 0) {
        throw new Error("Monthly upload limit must be a positive integer");
    }
    const local = localCalendar(date, timeZone);
    const released = local.day <= 10 ? 100_000_000_000
        : local.day <= 20 ? 300_000_000_000 : DEFAULT_MONTHLY_UPLOAD_LIMIT_BYTES;
    return {
        calendarMonth: local.month,
        timeZone,
        localDay: local.day,
        monthlyLimitBytes,
        releasedLimitBytes: Math.min(monthlyLimitBytes, released),
    };
}
