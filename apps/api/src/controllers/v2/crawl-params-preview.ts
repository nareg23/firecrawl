import { Response } from "express";
import { z } from "zod";
import {
  ErrorResponse,
  RequestWithAuth,
  crawlRequestSchema,
} from "./types";
import { logger as _logger } from "../../lib/logger";
import { generateCrawlerOptionsFromPrompt } from "../../scraper/scrapeURL/transformers/llmExtract";
import { CostTracking } from "../../lib/extract/extraction-service";

// Define the request schema for params preview
// Only url and prompt are required/relevant for preview
const crawlParamsPreviewRequestSchema = z.object({
  url: z.string().url(),
  prompt: z.string().max(10000),
});

type CrawlParamsPreviewRequest = z.infer<typeof crawlParamsPreviewRequestSchema>;

type CrawlParamsPreviewResponse = {
  success: true;
  data?: {
    url: string;
    includePaths?: string[];
    excludePaths?: string[];
    maxDepth?: number;
    maxDiscoveryDepth?: number;
    crawlEntireDomain?: boolean;
    allowExternalLinks?: boolean;
    allowSubdomains?: boolean;
    sitemap?: "skip" | "include";
    ignoreQueryParameters?: boolean;
    deduplicateSimilarURLs?: boolean;
    delay?: number;
    limit?: number;
  };
} | ErrorResponse;

export async function crawlParamsPreviewController(
  req: RequestWithAuth<{}, CrawlParamsPreviewResponse, CrawlParamsPreviewRequest>,
  res: Response<CrawlParamsPreviewResponse>,
) {
  const logger = _logger.child({
    module: "api/v2",
    method: "crawlParamsPreviewController",
    teamId: req.auth.team_id,
  });

  try {
    // Parse and validate request body
    const parsedBody = crawlParamsPreviewRequestSchema.parse(req.body);

    logger.debug("Crawl params preview request", {
      url: parsedBody.url,
      prompt: parsedBody.prompt,
    });

    // Generate crawler options from prompt
    const costTracking = new CostTracking();
    const { extract } = await generateCrawlerOptionsFromPrompt(
      parsedBody.prompt,
      logger,
      costTracking,
      { teamId: req.auth.team_id }
    );

    const generatedOptions = extract || {};

    logger.debug("Generated crawler options from prompt", {
      prompt: parsedBody.prompt,
      generatedOptions: generatedOptions,
    });

    // Prepare response data
    const responseData = {
      url: parsedBody.url,
      ...generatedOptions,
    };

    // Remove any undefined values for cleaner response
    Object.keys(responseData).forEach(key => {
      if (responseData[key] === undefined) {
        delete responseData[key];
      }
    });

    return res.status(200).json({
      success: true,
      data: responseData,
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error: "Invalid request parameters: " + error.errors.map(e => e.message).join(", "),
      });
    }

    logger.error("Failed to generate crawler params preview", {
      error: error.message,
      prompt: req.body.prompt,
    });

    return res.status(400).json({
      success: false,
      error: "Failed to process natural language prompt. Please try rephrasing.",
    });
  }
}