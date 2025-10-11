import * as types from "../common/types.js";
import * as playwrightLogin from "./playwrightLogin.js";
import * as puppeteerLogin from "./puppeteerLogin.js";

// TODO: use a better pattern
const usePlaywright = true
export async function extractTokens(): Promise<types.LoginResult> {
    if (usePlaywright) {
        return await playwrightLogin.extractTokens();
    } else {
        return await puppeteerLogin.extractTokens();
    }
}
