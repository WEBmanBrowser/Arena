/**
 * Custom Cloudflare Worker entry point.
 *
 * Re-uses the OpenNext-generated fetch handler for all HTTP requests (Next.js),
 * and adds a scheduled() handler for Cron Triggers.
 *
 * The cron `* /10 * * * *` calls the protected /api/cron/expire-reservations
 * endpoint to expire pending orders whose reservation window has elapsed.
 *
 * See: https://opennext.js.org/cloudflare/howtos/custom-worker
 */

// @ts-ignore — .open-next/worker.js is generated at build time
import { default as handler } from "./.open-next/worker.js";

// @ts-ignore — Cloudflare Worker types
const worker: Record<string, unknown> = {
  // Delegate all HTTP requests to OpenNext (Next.js)
  fetch: handler.fetch,

  // Cloudflare Cron Trigger handler — invoked by Cloudflare's ScheduledEvent
  async scheduled(
    controller: { cron: string; scheduledTime: number },
    env: Record<string, string>,
    ctx: { waitUntil: (p: Promise<unknown>) => void }
  ) {
    const cronSecret = env.CRON_SECRET || env.JWT_SECRET || "";

    ctx.waitUntil(
      (async () => {
        try {
          // Self-fetch to the protected cron endpoint via the OpenNext handler
          const response = await handler.fetch(
            new Request("https://localhost/api/cron/expire-reservations", {
              method: "POST",
              headers: {
                "x-cron-secret": cronSecret,
                "Content-Type": "application/json",
              },
            }),
            env,
            ctx
          );
          const result = await response.json();
          console.log(`[CRON ${controller.cron}] expire-reservations:`, result);
        } catch (err) {
          console.error(`[CRON ${controller.cron}] error:`, err);
        }
      })()
    );
  },
};

export default worker;
