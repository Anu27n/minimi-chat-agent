import { describe, expect, it } from "vitest";
import { resolveTimeReferences } from "../src/memory/temporal.js";
import { isoDate } from "../src/core/time.js";

// Tuesday 10 November 2026, 15:00 local time.
const NOW = new Date(2026, 10, 10, 15, 0);

function days(text: string) {
  return resolveTimeReferences(text, NOW).map((r) => ({ phrase: r.phrase, from: isoDate(r.start), to: isoDate(new Date(r.end.getTime() - 1)) }));
}

describe("resolveTimeReferences", () => {
  it("resolves the brief's example prompts", () => {
    expect(days("On Monday we shortlisted 5 CRM tools for a 20-person sales team.")).toEqual([
      { phrase: "On Monday", from: "2026-11-09", to: "2026-11-09" },
    ]);
    expect(days("Last Tuesday I asked you about Postgres hosting.")).toEqual([
      { phrase: "Last Tuesday", from: "2026-11-03", to: "2026-11-03" },
    ]);
    expect(days("What did I ask you on 3 November?")).toEqual([{ phrase: "on 3 November", from: "2026-11-03", to: "2026-11-03" }]);
  });

  it("handles relative days", () => {
    expect(days("yesterday")[0]).toMatchObject({ from: "2026-11-09", to: "2026-11-09" });
    expect(days("2 days ago")[0]).toMatchObject({ from: "2026-11-08", to: "2026-11-08" });
  });

  it("expands weeks and months to whole ranges", () => {
    expect(days("what did we discuss last week")[0]).toMatchObject({ from: "2026-11-02", to: "2026-11-08" });
    expect(days("anything from last month?")[0]).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("never returns future ranges, and clips today at now", () => {
    expect(days("next Friday")).toEqual([]);
    const today = resolveTimeReferences("today", NOW)[0]!;
    expect(today.end.getTime()).toBeLessThanOrEqual(NOW.getTime() + 1);
  });

  it("returns nothing when there is no date", () => {
    expect(days("Has Postgres hosting pricing changed?")).toEqual([]);
  });
});
