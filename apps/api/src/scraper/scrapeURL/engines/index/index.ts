import { Document } from "../../../../controllers/v1/types";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { getIndexFromGCS, hashURL, index_supabase_service, normalizeURLForIndex, saveIndexToGCS, generateURLSplits, addIndexInsertJob, generateDomainSplits, addOMCEJob, addDomainFrequencyJob } from "../../../../services";
import { EngineError, IndexMissError } from "../../error";
import crypto from "crypto";

export async function sendDocumentToIndex(meta: Meta, document: Document) {
    const shouldCache = meta.options.storeInCache
        && !meta.internalOptions.zeroDataRetention
        && meta.winnerEngine !== "index"
        && meta.winnerEngine !== "index;documents"
        && !(meta.winnerEngine === "pdf" && meta.options.parsers?.includes("pdf") === false)
        && (
            meta.internalOptions.teamId === "sitemap"
            || (
                meta.winnerEngine !== "fire-engine;tlsclient"
                && meta.winnerEngine !== "fire-engine;tlsclient;stealth"
                && meta.winnerEngine !== "fetch"
            )
        )
        && !meta.featureFlags.has("actions")
        && (
            meta.options.headers === undefined
            || Object.keys(meta.options.headers).length === 0
        );

    if (!shouldCache) {
        return document;
    }

    (async () => {
        try {
            const normalizedURL = normalizeURLForIndex(meta.url);
            const urlHash = hashURL(normalizedURL);

            const urlSplits = generateURLSplits(normalizedURL);
            const urlSplitsHash = urlSplits.map(split => hashURL(split));

            const urlObj = new URL(normalizedURL);
            const hostname = urlObj.hostname;

            const fakeDomain = meta.options.__experimental_omceDomain;
            const domainSplits = generateDomainSplits(hostname, fakeDomain);
            const domainSplitsHash = domainSplits.map(split => hashURL(split));

            const indexId = crypto.randomUUID();

            try {
                await saveIndexToGCS(indexId, {
                    url: document.metadata.url ?? document.metadata.sourceURL ?? meta.rewrittenUrl ?? meta.url,
                    html: document.rawHtml!,
                    statusCode: document.metadata.statusCode,
                    error: document.metadata.error,
                    screenshot: document.screenshot,
                    numPages: document.metadata.numPages,
                    contentType: document.metadata.contentType,
                });
            } catch (error) {
                meta.logger.error("Failed to save document to index", {
                    error,
                });
                return document;
            }

            let title = document.metadata.title ?? document.metadata.ogTitle ?? null;
            let description = document.metadata.description ?? document.metadata.ogDescription ?? document.metadata.dcDescription ?? null;

            if (typeof title === "string") {
                title = title.trim();
                if (title.length > 60) {
                    title = title.slice(0, 57) + "...";
                }
            } else {
                title = null;
            }

            if (typeof description === "string") {
                description = description.trim();
                if (description.length > 160) {
                    description = description.slice(0, 157) + "...";
                }
            } else {
                description = null;
            }

            try {
                await addIndexInsertJob({
                    id: indexId,
                    url: normalizedURL,
                    url_hash: urlHash,
                    original_url: document.metadata.sourceURL ?? meta.url,
                    resolved_url: document.metadata.url ?? document.metadata.sourceURL ?? meta.rewrittenUrl ?? meta.url,
                    has_screenshot: document.screenshot !== undefined && meta.featureFlags.has("screenshot"),
                    has_screenshot_fullscreen: document.screenshot !== undefined && meta.featureFlags.has("screenshot@fullScreen"),
                    is_mobile: meta.options.mobile,
                    block_ads: meta.options.blockAds,
                    location_country: meta.options.location?.country ?? null,
                    location_languages: meta.options.location?.languages ?? null,
                    status: document.metadata.statusCode,
                    ...(urlSplitsHash.slice(0, 10).reduce((a,x,i) => ({
                        ...a,
                        [`url_split_${i}_hash`]: x,
                    }), {})),
                    ...(domainSplitsHash.slice(0, 5).reduce((a,x,i) => ({
                        ...a,
                        [`domain_splits_${i}_hash`]: x,
                    }), {})),
                    ...(title ? { title } : {}),
                    ...(description ? { description } : {}),
                });
            } catch (error) {
                meta.logger.error("Failed to add document to index insert queue", {
                    error,
                });
            }

            if (domainSplits.length > 0) {
                try {
                    await addOMCEJob([domainSplits.length - 1, domainSplitsHash.slice(-1)[0]]);
                } catch (error) {
                    meta.logger.warn("Failed to add domain to OMCE job queue", {
                        error,
                    });
                }
            }
        } catch (error) {
            meta.logger.error("Failed to save document to index (outer)", {
                error,
            });
        }
    })();

    return document;
}

const errorCountToRegister = 3;

export async function scrapeURLWithIndex(meta: Meta): Promise<EngineScrapeResult> {
    const normalizedURL = normalizeURLForIndex(meta.url);
    const urlHash = hashURL(normalizedURL);

    let maxAge: number;
    if (meta.options.maxAge !== undefined) {
        maxAge = meta.options.maxAge;
    } else {
        const domainSplitsHash = generateDomainSplits(new URL(meta.url).hostname).map(x => hashURL(x));
        const level = domainSplitsHash.length - 1;

        if (domainSplitsHash.length === 0 || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true" || process.env.USE_DB_AUTHENTICATION !== "true") {
            maxAge = 2 * 24 * 60 * 60 * 1000; // 2 days
        } else {
            try {
                maxAge = await Promise.race([
                    (async () => {
                        const { data, error } = await index_supabase_service
                            .rpc("query_max_age", {
                                i_domain_hash: domainSplitsHash[level],
                            });
                        
                        if (error || !data || data.length === 0) {
                            meta.logger.warn("Failed to get max age from DB", {
                                error,
                            });
                            return 2 * 24 * 60 * 60 * 1000; // 2 days
                        }

                        return data[0].max_age ?? 2 * 24 * 60 * 60 * 1000; // 2 days
                    })(),
                    new Promise(resolve => setTimeout(() => {
                        resolve(2 * 24 * 60 * 60 * 1000); // 2 days
                    }, 200)),
                ]);
            } catch (e) {
                meta.logger.warn("Failed to get max age from DB", {
                    error: e,
                });
                maxAge = 2 * 24 * 60 * 60 * 1000; // 2 days
            }
        }
    }

    let selector = index_supabase_service
        .from("index")
        .select("id, created_at, status")
        .eq("url_hash", urlHash)
        .gte("created_at", new Date(Date.now() - maxAge).toISOString())
        .eq("is_mobile", meta.options.mobile)
        .eq("block_ads", meta.options.blockAds);
    
    if (meta.featureFlags.has("screenshot")) {
        selector = selector.eq("has_screenshot", true);
    }
    if (meta.featureFlags.has("screenshot@fullScreen")) {
        selector = selector.eq("has_screenshot_fullscreen", true);
    }
    if (meta.options.location?.country) {
        selector = selector.eq("location_country", meta.options.location.country);
    } else {
        selector = selector.is("location_country", null);
    }
    if (meta.options.location?.languages) {
        selector = selector.eq("location_languages", meta.options.location.languages);
    } else {
        selector = selector.is("location_languages", null);
    }

    const { data, error } = await selector
        .order("created_at", { ascending: false })
        .limit(5);

    if (error || !data) {
        throw new EngineError("Failed to retrieve URL from DB index", {
            cause: error,
        });
    }

    let selectedRow: {
        id: string;
        created_at: string;
        status: number;
    } | null = null;

    if (data.length > 0) {
        const newest200Index = data.findIndex(x => x.status >= 200 && x.status < 300);
        // If the newest 200 index is further back than the allowed error count, we should display the errored index entry
        if (newest200Index >= errorCountToRegister || newest200Index === -1) {
            selectedRow = data[0];
        } else {
            selectedRow = data[newest200Index];
        }
    }

    if (selectedRow === null || selectedRow === undefined) {
        throw new IndexMissError();
    }

    const id = data[0].id;

    const doc = await getIndexFromGCS(id + ".json", meta.logger.child({ module: "index", method: "getIndexFromGCS" }));
    if (!doc) {
        throw new EngineError("Document not found in GCS");
    }
    
    // Check if the cached content is a PDF base64 (starts with JVBERi)
    const isCachedPdfBase64 = doc.html && doc.html.startsWith("JVBERi");
    
    // If the cached content is base64 PDF but we want parsed PDF (parsePDF:true or default)
    if (isCachedPdfBase64 && meta.options.parsers?.includes("pdf") !== false) {
        // Cached content is unparsed PDF, but we want parsed - report cache miss
        throw new IndexMissError();
    }
    
    // If the cached content is NOT base64 PDF but we want unparsed PDF (parsePDF:false)
    if (!isCachedPdfBase64 && meta.options.parsers?.includes("pdf") === false) {
        // Check if URL looks like a PDF
        const isPdfUrl = meta.url.toLowerCase().endsWith(".pdf") || meta.url.includes(".pdf?");
        if (isPdfUrl) {
            // This is likely a parsed PDF cached, but we want unparsed - report cache miss
            throw new IndexMissError();
        }
    }
    
    return {
        url: doc.url,
        html: doc.html,
        statusCode: doc.statusCode,
        error: doc.error,
        screenshot: doc.screenshot,
        numPages: doc.numPages,
        contentType: doc.contentType,
        
        cacheInfo: {
            created_at: new Date(data[0].created_at),
        },

        proxyUsed: doc.proxyUsed ?? "basic",
    };
}

export function indexMaxReasonableTime(meta: Meta): number {
  return 1500;
}
