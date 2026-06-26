/**
 * PostgREST caps an unbounded select at 1000 rows (the server `max-rows` setting).
 * Any select that silently truncates at 1000 produces a WRONG result set. Go-live
 * incident 2026-06-25: a company with >1000 `skipped` rows had its overflow read out
 * of the dispatcher's synced-set, so already-handled orders leaked back as "unsynced".
 * Shared by the dispatcher anti-join and the verifier's sent-order scan.
 */
export const PAGE_SIZE = 1000;

/**
 * Paginate a PostgREST select past the 1000-row cap.
 *
 * `buildPage(from, to)` must return a PostgREST builder for the inclusive [from, to]
 * range, and MUST carry a stable `.order()` on a unique column -- PostgREST does not
 * guarantee row order across separate range requests, so without it pages can skip or
 * duplicate rows. Pages are fetched sequentially until a short page (< PAGE_SIZE)
 * signals the end. `context` prefixes any error thrown.
 */
export async function fetchAllPages<T>(
  buildPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  context: string,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildPage(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`${context}: ${error.message}`);
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) {
      break;
    }
    from += PAGE_SIZE;
  }
  return rows;
}
