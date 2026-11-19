// Time stamps in folder and file names, and the stored form of recording identities.

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

// "YYYY-MM-DD HHMMSS" in local time (recording folders), or "YYYY-MM-DDTHHMMSSZ" in UTC.
export function formatTimestampForPath(date: Date, utc = false): string {
    if (!Number.isFinite(date.getTime())) throw new Error("Cannot format an invalid timestamp");
    const [year, month, day, hours, minutes, seconds] = utc
        ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
        : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    const datePart = `${year}-${pad(month)}-${pad(day)}`;
    const timePart = `${pad(hours)}${pad(minutes)}${pad(seconds)}`;
    return utc ? `${datePart}T${timePart}Z` : `${datePart} ${timePart}`;
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// A recording identity is stored in segment names. One that is an ISO UTC time stamp
// ("2026-08-27T11:14:39Z") is stored compactly ("2026-08-27T111439Z"); any other value is
// kept as is. A site that compares identities itself uses this same form.
export function normalizeRecordingId(recordingId: string): string {
    if (UTC_TIMESTAMP.test(recordingId)) {
        return formatTimestampForPath(new Date(recordingId), true);
    }
    return recordingId;
}
