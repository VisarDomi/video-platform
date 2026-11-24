export { REQUEST_OVERHEAD_RESERVATION_BYTES } from "sdk";

// Uploads leave through an uplink: a network with its own allowance. `home` always exists;
// the sites file's optional "uplink" section adds one more.
export const HOME_UPLINK = "home";
export const DEFAULT_DAILY_UPLOAD_BYTES = 25_000_000_000;

export interface LocalCalendar {
    readonly month: string;
    readonly date: string;
    readonly day: number;
}

export function localCalendar(date: Date, timeZone: string): LocalCalendar {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const dayText = parts.find((part) => part.type === "day")?.value;
    const day = Number(dayText);
    if (!year || !month || !Number.isInteger(day) || day < 1 || day > 31) {
        throw new Error(`Could not derive upload calendar in ${timeZone}`);
    }
    return { month: `${year}-${month}`, date: `${year}-${month}-${dayText}`, day };
}

export function calendarMonth(date: Date, timeZone: string): string {
    return localCalendar(date, timeZone).month;
}

export function assertDailyBytes(dailyBytes: number): void {
    if (!Number.isSafeInteger(dailyBytes) || dailyBytes <= 0) {
        throw new Error("The daily upload allowance must be a positive integer");
    }
}

// The allowance is released per local day: on day N of the month, N daily amounts are
// released (unused bytes carry over until the month ends), and no more than two daily
// amounts leave in one local day. Spent and reserved bytes are the uplink's own.
export function uploadAllowance(
    now: Date,
    timeZone: string,
    dailyBytes: number,
    usage: { readonly spentMonth: number; readonly spentToday: number; readonly reserved: number },
) {
    assertDailyBytes(dailyBytes);
    const local = localCalendar(now, timeZone);
    const releasedBytes = dailyBytes * local.day;
    const availableBytes = releasedBytes - usage.spentMonth - usage.reserved;
    const todayRoomBytes = 2 * dailyBytes - usage.spentToday - usage.reserved;
    return {
        calendarMonth: local.month,
        localDate: local.date,
        localDay: local.day,
        timeZone,
        dailyBytes,
        releasedBytes,
        spentBytes: usage.spentMonth,
        spentTodayBytes: usage.spentToday,
        reservedBytes: usage.reserved,
        availableBytes: Math.max(0, availableBytes),
        todayRoomBytes: Math.max(0, todayRoomBytes),
        remainingBytes: Math.max(0, Math.min(availableBytes, todayRoomBytes)),
    };
}

export type UploadAllowance = ReturnType<typeof uploadAllowance>;
