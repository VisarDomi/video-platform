// The errors the core distinguishes are the SDK's, shared with destination plug-ins.
export { MetadataRejectedError, ProviderSessionLostError, TransferAbortedBeforeSubmissionError } from "sdk";

// A provider refusing words in the submitted metadata ("Sorry, 'X' is not
// allowed here.") is a hard form rejection: the video is not created. It is
// unrelated to the visibility label a published video can carry.
export function rejectedPhrases(text: string): string[] {
    return [...new Set([...text.matchAll(/Sorry, '([^'\n]+)' is not allowed here/g)]
        .map((match) => match[1].trim().toLowerCase()).filter(Boolean))];
}

// The campaign's session-lost attention text ends with this; resuming after a recovery
// recognises the text by it. The destination says the same in its own messages (a pin
// keeps the two identical until the generic session engine owns the text).
export const SESSION_LOST_ADVICE = "run `npm run vhost:connect-iphone` to restore the shared session";

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
// "surface" trips "ace". Mirror that instead of matching whole words.
export function containedPhrases(texts: readonly string[], phrases: readonly string[]): string[] {
    const haystack = texts.join("\n").toLowerCase();
    return phrases.filter((phrase) => haystack.includes(phrase.toLowerCase()));
}
