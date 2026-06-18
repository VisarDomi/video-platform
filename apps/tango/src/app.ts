import {ApplicationBuilder} from "./core/app.builder";

export class Application {
    public async start() {
        const builder = new ApplicationBuilder();
        builder.withEnvironment();
        await builder.withInitialData();
        await builder.withExternalScripts();
        const app = builder.build();
        await app.run();
    }
}
