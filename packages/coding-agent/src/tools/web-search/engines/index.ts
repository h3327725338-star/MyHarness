import type { WebSearchEngineId } from "../../../config/settings/types.ts";
import { bing } from "./bing.ts";
import { brave } from "./brave.ts";
import { duckduckgo } from "./duckduckgo.ts";
import { google } from "./google.ts";
import { tavily } from "./tavily.ts";
import type { SearchEngine } from "./types.ts";

export type {
	EngineResult,
	SearchEngine,
	SearchTimeRange,
} from "./types.ts";

export const WEB_SEARCH_ENGINES: Readonly<Record<WebSearchEngineId, SearchEngine>> = {
	google,
	bing,
	duckduckgo,
	brave,
	tavily,
};
