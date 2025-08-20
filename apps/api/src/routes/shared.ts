import { NextFunction, Request, Response } from "express";
// import { crawlStatusController } from "../../src/controllers/v1/crawl-status";
import {
  isAgentExtractModelValid,
  RequestWithACUC,
  RequestWithAuth,
  RequestWithMaybeAuth,
} from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
import { authenticateUser } from "../controllers/auth";
import { createIdempotencyKey } from "../services/idempotency/create";
import { validateIdempotencyKey } from "../services/idempotency/validate";
import { checkTeamCredits } from "../services/billing/credit_billing";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { logger } from "../lib/logger";
import { BLOCKLISTED_URL_MESSAGE } from "../lib/strings";
import { addDomainFrequencyJob } from "../services";

export function checkCreditsMiddleware(
  _minimum?: number,
): (req: RequestWithAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    let minimum = _minimum;
    (async () => {
      if (!minimum && req.body) {
        minimum =
          (req.body as any)?.limit ?? (req.body as any)?.urls?.length ?? 1;
      }
      const { success, remainingCredits, chunk } = await checkTeamCredits(
        req.acuc,
        req.auth.team_id,
        minimum ?? 1,
      );
      if (chunk) {
        req.acuc = chunk;
      }
      req.account = { remainingCredits };
      if (!success) {
        if (
          !minimum &&
          req.body &&
          (req.body as any).limit !== undefined &&
          remainingCredits > 0
        ) {
          logger.warn("Adjusting limit to remaining credits", {
            teamId: req.auth.team_id,
            remainingCredits,
            request: req.body,
          });
          (req.body as any).limit = remainingCredits;
          return next();
        }

        const currencyName = req.acuc.is_extract ? "tokens" : "credits";
        logger.error(
          `Insufficient ${currencyName}: ${JSON.stringify({ team_id: req.auth.team_id, minimum, remainingCredits })}`,
          {
            teamId: req.auth.team_id,
            minimum,
            remainingCredits,
            request: req.body,
            path: req.path,
          },
        );
        if (
          !res.headersSent &&
          req.auth.team_id !== "8c528896-7882-4587-a4b6-768b721b0b53"
        ) {
          return res.status(402).json({
            success: false,
            error:
              "Insufficient " +
              currencyName +
              " to perform this request. For more " +
              currencyName +
              ", you can upgrade your plan at " +
              (currencyName === "credits"
                ? "https://firecrawl.dev/pricing or try changing the request limit to a lower value"
                : "https://www.firecrawl.dev/extract#pricing") +
              ".",
          });
        }
      }
      next();
    })().catch((err) => next(err));
  };
}

export function authMiddleware(
  rateLimiterMode: RateLimiterMode,
): (req: RequestWithMaybeAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    (async () => {
      let currentRateLimiterMode = rateLimiterMode;
      if (
        currentRateLimiterMode === RateLimiterMode.Extract &&
        isAgentExtractModelValid((req.body as any)?.agent?.model)
      ) {
        currentRateLimiterMode = RateLimiterMode.ExtractAgentPreview;
      }

      // Track domain frequency regardless of caching
      try {
        // Use the URL from the request body if available
        const urlToTrack = (req.body as any)?.url;
        if (urlToTrack) {
          await addDomainFrequencyJob(urlToTrack);
        }
      } catch (error) {
        // Log error without meta.logger since it's not available in this context
        logger.warn("Failed to track domain frequency", { error });
      }

      // if (currentRateLimiterMode === RateLimiterMode.Scrape && isAgentExtractModelValid((req.body as any)?.agent?.model)) {
      //   currentRateLimiterMode = RateLimiterMode.ScrapeAgentPreview;
      // }

      const auth = await authenticateUser(req, res, currentRateLimiterMode);

      if (!auth.success) {
        if (!res.headersSent) {
          return res
            .status(auth.status)
            .json({ success: false, error: auth.error });
        } else {
          return;
        }
      }

      const { team_id, chunk } = auth;

      req.auth = { team_id };
      req.acuc = chunk ?? undefined;
      if (chunk) {
        req.account = { remainingCredits: chunk.remaining_credits };
      }
      next();
    })().catch((err) => next(err));
  };
}

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  (async () => {
    if (req.headers["x-idempotency-key"]) {
      const isIdempotencyValid = await validateIdempotencyKey(req);
      if (!isIdempotencyValid) {
        if (!res.headersSent) {
          return res
            .status(409)
            .json({ success: false, error: "Idempotency key already used" });
        }
      }
      createIdempotencyKey(req);
    }
    next();
  })().catch((err) => next(err));
}
export function blocklistMiddleware(
  req: RequestWithACUC<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  if (
    typeof req.body.url === "string" &&
    isUrlBlocked(req.body.url, req.acuc?.flags ?? null)
  ) {
    if (!res.headersSent) {
      return res.status(403).json({
        success: false,
        error: BLOCKLISTED_URL_MESSAGE,
      });
    }
  }
  next();
}

export function wrap(
  controller: (req: Request, res: Response) => Promise<any>,
): (req: Request, res: Response, next: NextFunction) => any {
  return (req, res, next) => {
    controller(req, res).catch((err) => next(err));
  };
}
