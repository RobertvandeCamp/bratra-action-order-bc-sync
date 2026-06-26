import { describe, it, expect, vi } from "vitest";
import { fetchAllPages, PAGE_SIZE } from "./paginate";

describe("fetchAllPages", () => {
  it("stopt na één korte pagina (< PAGE_SIZE)", async () => {
    const buildPage = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 1 }, { id: 2 }], error: null });

    const rows = await fetchAllPages<{ id: number }>(buildPage, "ctx");

    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(buildPage).toHaveBeenCalledTimes(1);
    expect(buildPage).toHaveBeenCalledWith(0, PAGE_SIZE - 1);
  });

  it("accumuleert over pagina's tot een korte pagina (>1000 rijen)", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i }));
    const tail = [{ id: 9001 }];
    const buildPage = vi
      .fn()
      .mockResolvedValueOnce({ data: full, error: null })
      .mockResolvedValueOnce({ data: tail, error: null });

    const rows = await fetchAllPages<{ id: number }>(buildPage, "ctx");

    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(buildPage).toHaveBeenCalledTimes(2);
    expect(buildPage).toHaveBeenNthCalledWith(1, 0, PAGE_SIZE - 1);
    expect(buildPage).toHaveBeenNthCalledWith(2, PAGE_SIZE, 2 * PAGE_SIZE - 1);
  });

  it("stopt bij een exacte-PAGE_SIZE eindpagina (volgende pagina leeg)", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i }));
    const buildPage = vi
      .fn()
      .mockResolvedValueOnce({ data: full, error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const rows = await fetchAllPages<{ id: number }>(buildPage, "ctx");

    expect(rows).toHaveLength(PAGE_SIZE);
    expect(buildPage).toHaveBeenCalledTimes(2);
  });

  it("gooit met context-prefix bij een query-error", async () => {
    const buildPage = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(fetchAllPages(buildPage, "load X")).rejects.toThrow("load X: boom");
  });
});
