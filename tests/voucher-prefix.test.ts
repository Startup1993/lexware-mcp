import { describe, expect, it, vi } from "vitest";
import type { Paged, VoucherlistEntry } from "../src/lexware/types.js";
import { scanVoucherlistByNumberPrefix } from "../src/tools/documents.js";

/** Build a fake voucherlist page from voucherNumbers. */
function page(numbers: string[], pageIdx: number, totalPages: number): Paged<VoucherlistEntry> {
  return {
    content: numbers.map((n, i) => ({
      id: `id-${pageIdx}-${i}`,
      voucherType: "salesinvoice",
      voucherStatus: "open",
      voucherNumber: n,
    })),
    first: pageIdx === 0,
    last: pageIdx === totalPages - 1,
    number: pageIdx,
    numberOfElements: numbers.length,
    size: 250,
    totalPages,
    totalElements: totalPages * numbers.length,
  };
}

/** Fake client whose get() returns the supplied pages in order. */
function clientReturning(pages: Paged<VoucherlistEntry>[]) {
  const get = vi.fn(async (_path: string, query?: Record<string, unknown>) => {
    return pages[(query?.page as number) ?? 0];
  });
  return { client: { get } as never, get };
}

describe("scanVoucherlistByNumberPrefix", () => {
  it("collects exactly targetCount matches and stops paging early", async () => {
    const { client, get } = clientReturning([
      page(["224002", "PR-9", "224001"], 0, 3),
      page(["224000", "PR-8", "223999"], 1, 3),
      page(["223998"], 2, 3),
    ]);
    const { matches, pagesScanned, scanCapped } = await scanVoucherlistByNumberPrefix(
      client,
      {},
      "224",
      2,
      20,
    );
    expect(matches.map((m) => m.voucherNumber)).toEqual(["224002", "224001"]);
    expect(pagesScanned).toBe(1); // target hit on the first page → no second fetch
    expect(scanCapped).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("is case-insensitive on the prefix", async () => {
    const { client } = clientReturning([page(["RE-2024-1", "re-2024-2", "X"], 0, 1)]);
    const { matches } = await scanVoucherlistByNumberPrefix(client, {}, "re-", 10, 20);
    expect(matches.map((m) => m.voucherNumber)).toEqual(["RE-2024-1", "re-2024-2"]);
  });

  it("requests newest-first and passes through filters", async () => {
    const { client, get } = clientReturning([page(["224002"], 0, 1)]);
    await scanVoucherlistByNumberPrefix(client, { voucherType: "salesinvoice" }, "224", 5, 20);
    expect(get).toHaveBeenCalledWith(
      "/v1/voucherlist",
      expect.objectContaining({ sort: "voucherDate,DESC", voucherType: "salesinvoice", page: 0 }),
    );
  });

  it("walks every page when matches are sparse and reports a clean end (not capped)", async () => {
    const { client, get } = clientReturning([
      page(["PR-1", "PR-2"], 0, 3),
      page(["PR-3", "224009"], 1, 3),
      page(["PR-4"], 2, 3),
    ]);
    const { matches, pagesScanned, scanCapped } = await scanVoucherlistByNumberPrefix(
      client,
      {},
      "224",
      5,
      20,
    );
    expect(matches.map((m) => m.voucherNumber)).toEqual(["224009"]);
    expect(pagesScanned).toBe(3);
    expect(scanCapped).toBe(false); // ran out of ledger, not the page cap
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("flags scanCapped when the page limit is hit before the ledger ends", async () => {
    const pages = [
      page(["PR-1"], 0, 10),
      page(["PR-2"], 1, 10),
      page(["PR-3"], 2, 10),
    ];
    const { client } = clientReturning(pages);
    const { matches, pagesScanned, scanCapped } = await scanVoucherlistByNumberPrefix(
      client,
      {},
      "224",
      5,
      3, // cap below totalPages (10)
    );
    expect(matches).toHaveLength(0);
    expect(pagesScanned).toBe(3);
    expect(scanCapped).toBe(true);
  });
});
