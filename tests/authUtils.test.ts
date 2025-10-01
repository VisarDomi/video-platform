// tests/authUtils.test.ts
import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import { parseJwtPayload } from '../src/auth/authUtils';

describe('Auth Utils :: parseJwtPayload', () => {

    it('should correctly parse a valid JWT and return its payload', () => {
        // This is a real-world example of a JWT structure.
        // The first part is the header, the second is the payload.
        // Payload: {"username": "testuser", "iat": 1516239022}
        const validJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6InRlc3R1c2VyIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

        const payload = parseJwtPayload(validJwt);

        expect(payload).not.toBeNull();
        expect(payload).toEqual({
            username: 'testuser',
            iat: 1516239022,
        });
    });

    it('should return null for a JWT with a missing payload section', () => {
        const invalidJwt = 'header.signature';
        const payload = parseJwtPayload(invalidJwt);
        expect(payload).toBeNull();
    });

    it('should return null for a string that is not a JWT', () => {
        const notAJwt = 'this is just a plain string';
        const payload = parseJwtPayload(notAJwt);
        expect(payload).toBeNull();
    });

    it('should return null for a JWT with a malformed payload', () => {
        // The payload part "not-valid-base64" is not valid Base64Url
        const malformedJwt = 'header.not-valid-base64.signature';
        const payload = parseJwtPayload(malformedJwt);
        expect(payload).toBeNull();
    });
});