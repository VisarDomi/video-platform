// src/auth/authUtils.ts
import logger from "../logger.js";

/**
 * Parses the payload of a JSON Web Token (JWT) without verifying its signature.
 * @param token The JWT string.
 * @returns The parsed payload object, or null if parsing fails.
 */
export function parseJwtPayload(token: string): { [key: string]: any } | null {
    try {
        const base64Url = token.split(".")[1];
        if (!base64Url) return null;
        const jsonPayload = Buffer.from(base64Url, "base64").toString();
        return JSON.parse(jsonPayload);
    } catch (error) {
        logger.error("Failed to parse JWT payload", { token, error });
        return null;
    }
}
