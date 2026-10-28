import { randomUUID } from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import { apiLimiter, corsMiddleware, csrfGuard } from "./middlewares/security.js";
import { apiRoutes } from "./routes.js";

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY); // so req.ip is the real client behind a proxy

  app.use(
    pinoHttp({
      logger,
      // Reuse a well-formed incoming X-Request-Id, otherwise create one.
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/api/v1/health" },
    }),
  );

  // JSON API only: lock down everything a browser could do with a response.
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );
  app.use(corsMiddleware);
  app.use(express.json({ limit: "200kb" }));
  app.use(cookieParser());
  app.use("/api", apiLimiter);
  app.use("/api", csrfGuard);
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); // API data is private
    next();
  });

  app.use("/api/v1", apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Default export is the entrypoint Vercel's Express runtime serves. */
const app = createApp();
export default app;
