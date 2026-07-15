/**
 * Next.js Node-process bootstrap. Recovery supervision remains independent of
 * new entries. The Live scheduler can open Triangle cycles only in production,
 * after Master Live and the account-scoped process owner are both valid.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureLiveSchedulerStarted } = await import("@/lib/runtime/live-scheduler");
  const {
    ensureTriangleStartupAuditCompleted,
    shouldRunTriangleStartupAudit
  } = await import("@/lib/runtime/triangle-startup-audit");
  // A skipped audit is not an execution authorization. Development, test,
  // Edge and build workers leave the production scheduler stopped.
  if (!shouldRunTriangleStartupAudit()) return;
  const audit = await ensureTriangleStartupAuditCompleted();
  if (audit.safeToStart) ensureLiveSchedulerStarted();
}
