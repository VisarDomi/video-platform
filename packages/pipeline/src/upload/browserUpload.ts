export interface ChromiumUploaderConfig {
    readonly executablePath: string;
    readonly profilePath: string;
    readonly email: string;
    readonly password: string;
    readonly headless?: boolean;
    // Shared-session file (see porntrexSession.ts).
    readonly sessionFilePath?: string;
}

export class HumanActionRequiredError extends Error {
    constructor(readonly action: "captcha" | "session_login" | "daily_limit", message: string) {
        super(message);
        this.name = "HumanActionRequiredError";
    }
}

