export { HumanActionRequiredError } from "sdk";

export interface ChromiumUploaderConfig {
    readonly executablePath: string;
    readonly profilePath: string;
    readonly email: string;
    readonly password: string;
    readonly headless?: boolean;
    // Shared-session file (see videohostSession.ts).
    readonly sessionFilePath?: string;
}
