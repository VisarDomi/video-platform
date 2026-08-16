import { chromium } from "playwright";
import { ChromiumXvideosUploader } from "./dist/upload/chromiumXvideosUploader.js";
import { readXvideosCredentials } from "./dist/config/secrets.js";

const profilePath = "/home/visar/.config/chromium-agent";
const artifactPath = "/home/visar/.local/share/video-services/pipeline/artifacts/45ce10f22daa3cd9bb1084343d7ae3087120ed2204ba08d8139b07b0492ca38e.mp4";
const creds = await readXvideosCredentials("/home/visar/Documents/work/video/video-platform/packages/.env");
const uploader = new ChromiumXvideosUploader({ executablePath: "/usr/bin/chromium", profilePath, ...creds });

const context = await chromium.launchPersistentContext(profilePath, {
    executablePath: "/usr/bin/chromium",
    headless: false,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled", "--remote-debugging-port=9222"],
    ignoreDefaultArgs: ["--enable-automation"],
});
const page = context.pages()[0] ?? await context.newPage();
await uploader.ensureAuthenticated(page);
await uploader.openUploadForm(page);
await page.locator("#file_form_file_terms").check();
await page.locator("#file_form_file_file_options_file_1_file").setInputFiles(artifactPath);
await page.getByRole("button", { name: "Upload", exact: true }).click();
await page.locator("#upload_form").waitFor({ state: "visible", timeout: 60_000 });
console.log(JSON.stringify({ event: "metadata-form-visible" }));

await uploader.fillUploadMetadata(page, {
    title: "Sexy Blonde Woman in Black Lingerie on Bed [2026-06-20 005838 boo_1234]",
    description: "A plus-sized blonde woman with long dark hair is lying on a brown bed with a yellow pillow. She is wearing a black bikni and poses facing the camera, looking seductive. The room has a modern look with gold-colored walls and furniture.\n\nRecorded: 2026-06-20 00:58:38\nSource: https://tango.me/OJaex4CNiMDEbTzB29pjMA\nAlias: https://tango.me/boo_1234",
    tags: ["tango", "live"],
});
console.log(JSON.stringify({ event: "metadata-filled" }));

const modelInput = page.locator("#upload_form_models .models-list > input[type=text]");
await modelInput.focus();
await page.keyboard.type("boo_1234");
await page.locator("#upload_form_models button[data-role=add]").click();
await page.waitForTimeout(2000);
console.log(JSON.stringify({ event: "ready-for-save-test", url: page.url() }));
await new Promise(() => {});
