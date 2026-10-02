// These affect provider visibility, not whether the upload exists. Never
// interpret the account-wide "N videos blocked" banner as this video's flag.
export function limitedVisibilityWarning(text: string): string | null {
    const warnings = [...new Set(text.match(/Sorry, '[^'\n]+' is not allowed here\.?/g) ?? [])];
    if (warnings.length) return warnings.join(" ");
    return /limited visibility/i.test(text) ? "Provider reports limited visibility" : null;
}
