import { ApplicationBuilder } from "./core/app.builder";

export class Application {
    public async start() {
        try {
            const builder = new ApplicationBuilder();

            builder.withEnvironment().withApiConfig({ credentials: "include", mode: "cors" } as const);

            await builder.withInitialData();
            await builder.withExternalScripts();

            const app = builder.build();

            await app.run();
        } catch (error) {
            console.error("Failed to initialize the application:", error);
        }
    }
}
