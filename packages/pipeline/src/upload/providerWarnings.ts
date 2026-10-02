// A provider refusing words in the submitted metadata ("Sorry, 'X' is not
// allowed here.") is a hard form rejection: the video is not created. It is
// unrelated to the visibility label a published video can carry.
export function rejectedPhrases(text: string): string[] {
    return [...new Set([...text.matchAll(/Sorry, '([^'\n]+)' is not allowed here/g)]
        .map((match) => match[1].trim().toLowerCase()).filter(Boolean))];
}

// The provider refused words in submitted metadata. The form was not accepted,
// so no remote video exists; the phrases are learned for the next description.
export class MetadataRejectedError extends Error {
    constructor(readonly phrases: readonly string[]) {
        super(`Provider rejected metadata phrase(s): ${phrases.map((phrase) => `'${phrase}'`).join(", ")}`);
        this.name = "MetadataRejectedError";
    }
}

// The file transfer stopped before the provider offered its metadata form.
// On a two-step provider (Porntrex) the video only exists after that form is
// submitted, so nothing was published; the next attempt still looks up first.
export class TransferAbortedBeforeSubmissionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TransferAbortedBeforeSubmissionError";
    }
}

// The provider account's single login moved to another device (or ended).
// Raised before any metadata submission, so it is a plain failure; the
// campaign pauses until `npm run ptrex:connect-iphone` restores the shared session.
export class ProviderSessionLostError extends TransferAbortedBeforeSubmissionError {
    constructor(message: string) {
        super(message);
        this.name = "ProviderSessionLostError";
    }
}

export const SESSION_LOST_ADVICE = "run `npm run ptrex:connect-iphone` to restore the shared session";

// Informational only: a published video whose reach the provider limited.
// Never interpret the account-wide "N videos blocked" banner as this video's flag.
export function limitedVisibilityWarning(text: string): string | null {
    const label = text.match(/limited visibility due to\s*:?\s*([^\n.]+)/i)?.[1]?.trim();
    if (label) return `Provider reports limited visibility: ${label}`;
    return /limited visibility/i.test(text) ? "Provider reports limited visibility" : null;
}

// A video the account owner deleted stays listed with a deletion status until
// the provider removes it (then its edit page is 404). Either way it is gone.
export function isRemovalPendingStatus(status: string): boolean {
    return /delet/i.test(status);
}

// Providers match their blocked words as case-insensitive substrings, so
// "ambient" trips "ambien". Mirror that instead of matching whole words.
export function containedPhrases(texts: readonly string[], phrases: readonly string[]): string[] {
    const haystack = texts.join("\n").toLowerCase();
    return phrases.filter((phrase) => haystack.includes(phrase.toLowerCase()));
}
