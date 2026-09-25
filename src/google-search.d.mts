export type GoogleResult = { rank: number; title: string; url: string; snippet: string };
export type ParsedResults = { results: GoogleResult[]; nextStart: number | null };
export type GooglePage = ParsedResults & { query: string; start: number };
export type SearchOptions = { signal?: AbortSignal };
export type Search = (query: string, start?: number, options?: SearchOptions) => Promise<GooglePage>;
export class SearchError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export function parseResults(html: string, start?: number): ParsedResults;
export function createSearch(): Search;
export const search: Search;
export function search100(query: string): Promise<ParsedResults & { query: string; pages: number }>;
