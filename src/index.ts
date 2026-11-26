import { startWorker } from "./worker.js";

process.on("unhandledRejection", (reason) => {
  console.error("[unhandled-rejection]", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaught-exception]", error);
  process.exitCode = 1;
});

await startWorker();
