export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startJobs } = await import("./server/jobs");
    try {
      startJobs();
    } catch (e) {
      console.error("[hearth] failed to start scheduler", e);
    }
  }
}
