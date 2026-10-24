import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function main(): Promise<void> {
  const { createApp } = await import("./app");
  const handle = await createApp();
  const { app, cfg, loaded } = handle;
  const warnings = loaded.problems.length + (cfg.versionWarning ? 1 : 0);
  const server = app.listen(cfg.port, () => {
    console.log(`[dropcut] http://localhost:${cfg.port} backend=${cfg.backend} workflowProblems=${warnings}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[dropcut] could not listen on port ${cfg.port}: ${err.message}`);
    process.exit(1);
  });
}

void main();
